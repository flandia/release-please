// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {describe, it, afterEach, beforeEach} from 'mocha';
import * as sinon from 'sinon';
import {GitHub} from '../../../src/github';
import {FileNotFoundError} from '../../../src/errors';
import {Manifest} from '../../../src/manifest';
import {Update} from '../../../src/update';
import {
  buildGitHubFileContent,
  mockReleases,
  mockCommits,
  safeSnapshot,
  stubFilesFromFixtures,
  assertHasUpdates,
} from '../../helpers';
import {Version} from '../../../src/version';
import {PackageJson} from '../../../src/updaters/node/package-json';
import {expect} from 'chai';
import {Changelog} from '../../../src/updaters/changelog';

const sandbox = sinon.createSandbox();
const fixturesPath = './test/fixtures/plugins/node-workspace';

export function buildMockPackageUpdate(
  path: string,
  fixtureName: string
): Update {
  const cachedFileContents = buildGitHubFileContent(fixturesPath, fixtureName);
  return {
    path,
    createIfMissing: false,
    cachedFileContents,
    updater: new PackageJson({
      version: Version.parse(
        JSON.parse(cachedFileContents.parsedContent).version
      ),
    }),
  };
}

describe('Plugin compatibility', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake-owner',
      repo: 'fake-repo',
      defaultBranch: 'main',
    });
  });
  afterEach(() => {
    sandbox.restore();
  });
  describe('separate-pull-requests and workspace plugin', () => {
    // Unlabelled forced releases can merge without a tag, and a shared manifest
    // can claim a dependent version before that dependent's PR has merged.
    for (const [description, labels] of [
      ['default labels', undefined],
      ['configured labels', ['release: waiting', 'release: validated']],
    ] as const) {
      it(`preserves candidate labels and manifest ownership with ${description}`, async () => {
        const paths = ['node1', 'node2', 'node3', 'node4'];
        const names = ['pkgA', 'pkgB', 'pkgC', 'pkgD'];
        const base = Object.fromEntries(paths.map(path => [`packages/${path}`, '1.0.0']));
        mockReleases(sandbox, github, names.map((name, index) => ({
          id: index + 1, sha: 'abc123', tagName: `${name}-v1.0.0`,
          url: `https://github.com/fake-owner/fake-repo/releases/tag/${name}-v1.0.0`,
        })));
        mockCommits(sandbox, github, [{
          sha: 'aaaaaa', message: 'feat: some feature', files: ['packages/node3/foo'],
        }]);
        const inlineFiles: [string, string][] = [
          ['package.json', JSON.stringify({name: 'root', private: true, workspaces: ['packages/*']})],
          ['.release-please-manifest.json', JSON.stringify(base)],
        ];
        for (let i = 0; i < paths.length; i++) {
          inlineFiles.push([
            `packages/${paths[i]}/package.json`,
            JSON.stringify({
              name: names[i], version: '1.0.0',
              ...(i < 2 ? {dependencies: {pkgC: 'workspace:*'}} : {}),
            }),
          ]);
          inlineFiles.push([`packages/${paths[i]}/CHANGELOG.md`, '# Changelog\n']);
        }
        stubFilesFromFixtures({
          sandbox, github, fixturePath: fixturesPath, files: [], inlineFiles,
          flatten: false, targetBranch: 'main',
        });
        (github.getFileContentsOnBranch as sinon.SinonStub).rejects(new FileNotFoundError('missing'));
        const findFiles = sandbox.stub(github, 'findFilesByGlobAndRef');
        for (const path of paths) {
          findFiles.withArgs(`packages/${path}`, 'main').resolves([`packages/${path}`]);
        }
        const manifest = new Manifest(
          github, 'main',
          Object.fromEntries(paths.map((path, i) => [
            `packages/${path}`, {releaseType: 'node', component: names[i]},
          ])),
          Object.fromEntries(paths.map(path => [`packages/${path}`, Version.parse('1.0.0')])),
          {
            plugins: [{type: 'node-workspace'}], separatePullRequests: true,
            ...(labels ? {labels: [...labels]} : {}),
          }
        );
        const candidates = await manifest.buildPullRequests();
        const byPath = new Map(candidates.map(candidate => {
          const path = paths.find(item =>
            candidate.updates.some(update => update.path === `packages/${item}/CHANGELOG.md`)
          );
          return [path, candidate];
        }));
        expect([...byPath.keys()].sort()).to.eql(['node1', 'node2', 'node3']);
        const actual = [];
        const expected = [];
        for (const path of ['node1', 'node2', 'node3']) {
          const candidate = byPath.get(path)!;
          const version = path === 'node3' ? '1.1.0' : '1.0.1';
          const changes = await github.buildChangeSet(candidate.updates, 'main');
          const manifestChange = changes.get('.release-please-manifest.json');
          const changedManifest = manifestChange ? JSON.parse(manifestChange.content!) : base;
          const versions = Object.fromEntries(paths.map(item => {
            const original = JSON.parse(inlineFiles.find(([file]) =>
              file === `packages/${item}/package.json`
            )![1]);
            const change = changes.get(`packages/${item}/package.json`);
            return [item, change ? JSON.parse(change.content!).version : original.version];
          }));
          actual.push({
            path, labels: [...candidate.labels].sort(), manifest: changedManifest, versions,
            dependencyNote: path === 'node3' || candidate.body.toString().includes('pkgC bumped to 1.1.0'),
          });
          expected.push({
            path, labels: [...(labels ?? ['autorelease: pending'])].sort(),
            manifest: {...base, [`packages/${path}`]: version},
            versions: Object.fromEntries(paths.map(item => [item, item === path ? version : '1.0.0'])),
            dependencyNote: true,
          });
        }
        expect(actual).to.eql(expected);
      });
    }
    it('should version bump dependencies together', async () => {
      // Scenario:
      //   - package a,b depends on c
      //   - package c receives a new feature
      //   - package a,b version bumps its dependency on c
      //   - package a and b should both use a minor version bump
      //   - each package should have its own PR
      mockReleases(sandbox, github, [
        {
          id: 123456,
          sha: 'abc123',
          tagName: 'pkgA-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgA-v1.0.0',
        },
        {
          id: 654321,
          sha: 'abc123',
          tagName: 'pkgB-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgB-v1.0.0',
        },
        {
          id: 987654,
          sha: 'abc123',
          tagName: 'pkgC-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgC-v1.0.0',
        },
      ]);
      mockCommits(sandbox, github, [
        {
          sha: 'aaaaaa',
          message: 'feat: some feature',
          files: ['packages/node3/foo'],
        },
      ]);
      stubFilesFromFixtures({
        sandbox,
        github,
        fixturePath: fixturesPath,
        files: [],
        flatten: false,
        targetBranch: 'main',
        inlineFiles: [
          [
            'package.json',
            '{ "name": "root", "version": "2.0.0", "workspaces": ["packages/*"] }',
          ],
          [
            'packages/node1/package.json',
            '{ "name": "pkgA", "version": "1.0.0", "dependencies": { "pkgC": "workspace:*" } }',
          ],
          [
            'packages/node2/package.json',
            '{ "name": "pkgB", "version": "1.0.0", "dependencies": { "pkgC": "workspace:*" } }',
          ],
          [
            'packages/node3/package.json',
            '{ "name": "pkgC", "version": "1.0.0" }',
          ],
        ],
      });
      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/node1', 'main')
        .resolves(['packages/node1'])
        .withArgs('packages/node2', 'main')
        .resolves(['packages/node2'])
        .withArgs('packages/node3', 'main')
        .resolves(['packages/node3']);
      const manifest = new Manifest(
        github,
        'main',
        {
          'packages/node1': {
            releaseType: 'node',
            component: 'pkgA',
          },
          'packages/node2': {
            releaseType: 'node',
            component: 'pkgB',
          },
          'packages/node3': {
            releaseType: 'node',
            component: 'pkgC',
          },
        },
        {
          'packages/node1': Version.parse('1.0.0'),
          'packages/node2': Version.parse('1.0.0'),
          'packages/node3': Version.parse('1.0.0'),
        },
        {
          plugins: [{type: 'node-workspace'}],
          separatePullRequests: true,
        }
      );
      const pullRequests = await manifest.buildPullRequests();
      expect(pullRequests).lengthOf(3);

      const pullRequest1 = pullRequests[0];
      safeSnapshot(pullRequest1.body.toString());
      const updaterA = (
        assertHasUpdates(
          pullRequest1.updates,
          'packages/node1/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterA.version.toString()).to.eql('1.0.1');

      const pullRequest2 = pullRequests[1];
      safeSnapshot(pullRequest2.body.toString());
      const updaterB = (
        assertHasUpdates(
          pullRequest2.updates,
          'packages/node2/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterB.version.toString()).to.eql('1.0.1');

      const pullRequest3 = pullRequests[2];
      safeSnapshot(pullRequest3.body.toString());
      const updaterC = (
        assertHasUpdates(
          pullRequest3.updates,
          'packages/node3/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterC.version.toString()).to.eql('1.1.0');
    });
  });
});
