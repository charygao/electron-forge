import 'colors';
import debug from 'debug';
import fs from 'fs-extra';
import path from 'path';

import asyncOra from '../util/ora-handler';
import deprecate from '../util/deprecate';
import getForgeConfig from '../util/forge-config';
import readPackageJSON from '../util/read-package-json';
import requireSearch from '../util/require-search';
import resolveDir from '../util/resolve-dir';
import PublishState from '../util/publish-state';

import make from './make';

const d = debug('electron-forge:publish');

/**
 * @typedef {Object} PublishOptions
 * @property {string} [dir=process.cwd()] The path to the app to be published
 * @property {boolean} [interactive=false] Whether to use sensible defaults or prompt the user visually
 * @property {string} [authToken] An authentication token to use when publishing
 * @property {string} [tag=packageJSON.version] The string to tag this release with
 * @property {string} [target=github] The publish target
 * @property {MakeOptions} [makeOptions] Options object to passed through to make()
 * @property {string} [outDir=`${dir}/out`] The path to the directory containing generated distributables
 * @property {boolean} [dryRun=false] Whether or not to generate dry run meta data and not actually publish
 * @property {boolean} [dryRunResume=false] Whether or not to attempt to resume a previously saved dryRun and publish
 * @property {Object} [makeResults=null] Provide results from make so that the publish step doesn't run make itself
 */

/**
 * Publish an Electron application into the given target service.
 *
 * @param {PublishOptions} providedOptions - Options for the Publish method
 * @return {Promise} Will resolve when the publish process is complete
 */
const publish = async (providedOptions = {}) => {
  // eslint-disable-next-line prefer-const, no-unused-vars
  let { dir, interactive, authToken, tag, target, makeOptions, dryRun, dryRunResume, makeResults } = Object.assign({
    dir: process.cwd(),
    interactive: false,
    tag: null,
    makeOptions: {},
    target: null,
    dryRun: false,
    dryRunResume: false,
    makeResults: null,
  }, providedOptions);
  asyncOra.interactive = interactive;
  // FIXME(MarshallOfSound): Change the method param to publishTargets in the next major bump
  let publishTargets = target;

  const outDir = providedOptions.outDir || path.resolve(dir, 'out');
  const dryRunDir = path.resolve(outDir, 'publish-dry-run');

  if (dryRun && dryRunResume) {
    throw 'Can\'t dry run and resume a dry run at the same time';
  }
  if (dryRunResume && makeResults) {
    throw 'Can\'t resume a dry run and use the provided makeResults at the same time';
  }

  let packageJSON = await readPackageJSON(dir);

  let forgeConfig = await getForgeConfig(dir);

  if (dryRunResume) {
    d('attempting to resume from dry run');
    const publishes = await PublishState.loadFromDirectory(dryRunDir);
    for (const states of publishes) {
      d('publishing for given state set');
      await publish({
        dir,
        interactive,
        authToken,
        tag,
        target,
        makeOptions,
        dryRun,
        dryRunResume: false,
        makeResults: states.map(({ state }) => state),
      });
    }
    return;
  } else if (!makeResults) {
    d('triggering make');
    makeResults = await make(Object.assign({
      dir,
      interactive,
    }, makeOptions));
  } else {
    // Restore values from dry run
    d('restoring publish settings from dry run');

    for (const makeResult of makeResults) {
      packageJSON = makeResult.packageJSON;
      forgeConfig = makeResult.forgeConfig;
      makeOptions.platform = makeResult.platform;
      makeOptions.arch = makeResult.arch;

      for (const makePath of makeResult.paths) {
        if (!await fs.exists(makePath)) {
          throw `Attempted to resume a dry run but an artifact (${makePath}) could not be found`;
        }
      }
    }

    makeResults = makeResults.map(makeResult => makeResult.paths);
  }

  if (dryRun) {
    d('saving results of make in dry run state');
    await fs.remove(dryRunDir);
    await PublishState.saveToDirectory(dryRunDir, makeResults);
    return;
  }

  dir = await resolveDir(dir);
  if (!dir) {
    throw 'Failed to locate publishable Electron application';
  }

  const artifacts = makeResults.reduce((accum, arr) => {
    accum.push(...arr);
    return accum;
  }, []);

  if (publishTargets === null) {
    publishTargets = forgeConfig.publish_targets[makeOptions.platform || process.platform];
  } else if (typeof publishTargets === 'string') {
    // FIXME(MarshallOfSound): Remove this fallback string typeof check in the next major bump
    deprecate('publish target as a string').replaceWith('an array of publish targets');
    publishTargets = [publishTargets];
  }

  for (const publishTarget of publishTargets) {
    let publisher;
    await asyncOra(`Resolving publish target: ${`${publishTarget}`.cyan}`, async () => { // eslint-disable-line no-loop-func
      publisher = requireSearch(__dirname, [
        `../publishers/${publishTarget}.js`,
        `electron-forge-publisher-${publishTarget}`,
        publishTarget,
        path.resolve(dir, publishTarget),
        path.resolve(dir, 'node_modules', publishTarget),
      ]);
      if (!publisher) {
        throw `Could not find a publish target with the name: ${publishTarget}`;
      }
    });

    await publisher(artifacts, packageJSON, forgeConfig, authToken, tag, makeOptions.platform || process.platform, makeOptions.arch || process.arch);
  }
};

export default publish;
