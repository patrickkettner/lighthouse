/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * @fileoverview
 *    - sets global.expect
 *    - configures mocha to use jest-snapshot
 *    - symlinks `fixtures/config-plugins/lighthouse-plugin-simple` to a place where the default
 *      config module resolution will find it
 *    - saves failed test results if env LH_FAILED_TESTS_FILE is set
 */

/* eslint-disable import/order */

// TODO: all of test-env should be moved to a root test folder

import fs from 'fs';

import path from 'path';
import {expect} from 'expect';
import * as td from 'testdouble';
import jestSnapshot from 'jest-snapshot';

import {LH_ROOT} from '../../../root.js';
import './expect-setup.js';
import {timers} from './fake-timers.js';

const {SnapshotState, toMatchSnapshot, toMatchInlineSnapshot} = jestSnapshot;

// Use consistent TZ across testing environments.
// Timezone is used to construct date strings.
process.env.TZ = 'UTC';

// Expected to be set by lh-env.js
process.env.NODE_TEST = 'test';

global.expect = expect;

// Force marky to not use Node's performance, which is messed up by fake timers.
const performance = global.performance;
// @ts-expect-error
global.performance = undefined;
// @ts-expect-error: no types
await import('marky');
global.performance = performance;

/** @type {Map<string, SnapshotState['prototype']>} */
const snapshotStatesByTestFile = new Map();
let snapshotTestFailed = false;

/**
 * @param {string} testFile
 */
function getSnapshotState(testFile) {
  // For every test file, persist the same snapshot state object so there is
  // not a read/write per snapshot access/change, but one per file.
  let snapshotState = snapshotStatesByTestFile.get(testFile);
  if (snapshotState) return snapshotState;

  const snapshotDir = path.join(path.dirname(testFile), '__snapshots__');
  const snapshotFile = path.join(snapshotDir, path.basename(testFile) + '.snap');
  snapshotState = new SnapshotState(snapshotFile, {
    updateSnapshot: process.env.SNAPSHOT_UPDATE ? 'all' : 'new',
    prettierPath: '',
    snapshotFormat: {},
  });
  snapshotStatesByTestFile.set(testFile, snapshotState);
  return snapshotState;
}

/**
 * @param {Mocha.Test} test
 * @return {string}
 */
function makeTestTitle(test) {
  /** @type {Mocha.Test | Mocha.Suite} */
  let next = test;
  const title = [];

  while (next.parent) {
    title.push(next.title);
    next = next.parent;
  }

  return title.reverse().join(' ');
}

expect.extend({
  /**
   * @param {any} actual
   */
  toMatchSnapshot(actual) {
    const test = mochaCurrentTest;
    if (!test.file) throw new Error('unexpected value');

    const title = makeTestTitle(test);
    const snapshotState = getSnapshotState(test.file);
    const context = {snapshotState, currentTestName: title};
    // @ts-expect-error - this is enough for snapshots to work.
    const matcher = toMatchSnapshot.bind(context);
    const result = matcher(actual);
    // @ts-expect-error - not sure why these types are so wrong
    if (!result.pass) snapshotTestFailed = true;
    return result;
  },
  /**
   * @param {any} actual
   * @param {any} expected
   */
  toMatchInlineSnapshot(actual, expected) {
    const test = mochaCurrentTest;
    if (!test.file) throw new Error('unexpected value');

    const title = makeTestTitle(test);
    const snapshotState = getSnapshotState(test.file);
    const context = {snapshotState, currentTestName: title};
    // @ts-expect-error - this is enough for snapshots to work.
    const matcher = toMatchInlineSnapshot.bind(context);
    // @ts-expect-error - not sure why these types are so wrong
    const result = matcher(actual, expected);
    // @ts-expect-error - not sure why these types are so wrong
    if (!result.pass) snapshotTestFailed = true;
    return result;
  },
});

const testPlugins = [
  'lighthouse-plugin-no-category',
  'lighthouse-plugin-no-groups',
  'lighthouse-plugin-simple',
];

/** @type {Mocha.Test} */
let mochaCurrentTest;

/** @type {any[]} */
const failedTests = [];

const rootHooks = {
  /** @this {Mocha.Context} */
  beforeEach() {
    if (!this.currentTest) throw new Error('unexpected value');

    // Needed so `expect` extension method can access information about the current test.
    mochaCurrentTest = this.currentTest;
  },
  /** @this {Mocha.Context} */
  afterEach() {
    if (!this.currentTest) throw new Error('unexpected value');

    const {file, title, state} = this.currentTest;
    if (!file) throw new Error('unexpected value');

    if (state === 'failed') {
      failedTests.push({
        file: path.relative(LH_ROOT, file),
        title,
        error: this.currentTest.err?.toString(),
      });
    }
  },
  async afterAll() {
    timers.dispose();
    td.reset();

    for (const snapshotState of snapshotStatesByTestFile.values()) {
      // Jest adds `file://` to inline snapshot paths, and uses its own fs module to read things,
      // falling back to fs.readFileSync if not defined. node `fs` does not support
      // protocols in the path specifier, so we remove it here.
      // @ts-expect-error - private property.
      for (const snapshot of snapshotState._inlineSnapshots) {
        snapshot.frame.file = snapshot.frame.file.replace('file://', '');
      }

      snapshotState.save();
    }

    if (!process.env.SNAPSHOT_UPDATE && snapshotTestFailed) {
      process.on('exit', () => {
        console.log('To update snapshots, run again with `yarn mocha -u`');
      });
    }

    if (process.env.LH_FAILED_TESTS_FILE && failedTests.length) {
      fs.writeFileSync(process.env.LH_FAILED_TESTS_FILE, JSON.stringify(failedTests, null, 2));
    }
  },
};

function mochaGlobalSetup() {
  for (const plugin of testPlugins) {
    try {
      fs.symlinkSync(
        `${LH_ROOT}/lighthouse-core/test/fixtures/config-plugins/${plugin}`,
        `${LH_ROOT}/node_modules/${plugin}`
      );
    } catch {
      // Might exist already because process was killed before tests finished.
    }
  }
}

function mochaGlobalTeardown() {
  for (const plugin of testPlugins) {
    fs.unlinkSync(`${LH_ROOT}/node_modules/${plugin}`);
  }
}

export {
  rootHooks,
  mochaGlobalSetup,
  mochaGlobalTeardown,
};
