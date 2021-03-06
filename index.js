'use strict';

const path = require('path');
const debug = require('debug')('ember-cli-bundle-analyzer');
const { createOutput, summarizeAll } = require('broccoli-concat-analyser');
const fs = require('fs');
const sane = require('sane');
const touch = require('touch');
const hashFiles = require('hash-files').sync;
const tmp = require('tmp');
const VersionChecker = require('ember-cli-version-checker');
const interceptStdout = require('intercept-stdout');
const injectLivereload = require('./lib/inject-livereload');

const REQUEST_PATH = '/_analyze';
const BROCCOLI_CONCAT_PATH_SUPPORT = '3.6.0';
const BROCCOLI_CONCAT_LAZY_SUPPORT = '3.7.0';

module.exports = {
  name: require('./package').name,

  _hashedFiles: {},
  _statsOutput: null,
  _hasWatcher: false,
  _buildCallback: null,
  _computePromise: null,
  _buildPromise: null,

  init() {
    this._super.init && this._super.init.apply(this, arguments);
    debug(`${this.name} started.`);

    let checker = new VersionChecker(this);
    this.concatVersion = checker.for('broccoli-concat');

    if (this.concatVersion.lt(BROCCOLI_CONCAT_LAZY_SUPPORT)) {
      debug(`broccoli-concat v${this.concatVersion.version} does not support lazy stats activation, forced to activate prematurely.`);
      this.enableStats();
    }
    this.initConcatStatsPath();
  },

  included(app) {
    this._super.included.apply(this, arguments);
    // this.app = app;
    let options = app.options['bundle-analyzer'] || {};

    let ignoredFiles = options && options.ignore || [];
    if (!Array.isArray(ignoredFiles)) {
      ignoredFiles = [ignoredFiles];
    }

    // it seems ember itself bundles its files before they are added to vender.js, which causes concat stats to be
    // generated which are irrelevant to the final bundle. So exclude them...
    ignoredFiles = ignoredFiles.concat('ember.js', 'ember-testing.js');

    if (options.ignoreTestFiles !== false) {
      ignoredFiles = ignoredFiles.concat('tests.js', 'test-support.js', 'test-support.css', '*-test.js');
    }

    this.ignoredFiles = ignoredFiles;
  },

  initConcatStatsPath() {
    // if broccoli-concat supports a custom path for stats data, put the data in a temp folder outside of the project!
    if (this.concatVersion.gte(BROCCOLI_CONCAT_PATH_SUPPORT)) {
      this.concatStatsPath = tmp.dirSync().name;
      process.env.CONCAT_STATS_PATH = this.concatStatsPath;
    } else {
      this.concatStatsPath = path.join(process.cwd(), 'concat-stats-for');
    }
  },

  serverMiddleware(config) {
    if (this.isEnabled()) {
      this.addAnalyzeMiddleware(config);
    }
  },

  addAnalyzeMiddleware(config) {
    let app = config.app;

    app.get(REQUEST_PATH, (req, res) => {
      this.initBuildWatcher();
      Promise.resolve()
        .then(() => this._buildPromise)
        .then(() => {
          if (!this.hasStats()) {
            res.sendFile(path.join(__dirname, 'lib', 'output', 'computing', 'index.html'));
            return;
          }

          if (!this._statsOutput) {
            res.sendFile(path.join(__dirname, 'lib', 'output', 'computing', 'index.html'));
          } else {
            res.send(this._statsOutput);
          }
        });
    });

    app.get(`${REQUEST_PATH}/compute`, (req, res) => {
      this.initWatcher();
      this.initBuildWatcher();
      Promise.resolve()
        .then(() => this._buildPromise)
        .then(() => {
          if (!this.hasStats()) {
            this.enableStats();
            this.triggerBuild();
            return this._initialBuildPromise;
          }
        })
        .then(() => {
          // @todo make this throw an exception when there are no stats
          this.computeOutput()
            .then((output) => {
              this._statsOutput = injectLivereload(output);
              res.redirect(REQUEST_PATH);
            })
            .catch((e) => {
              this.ui.writeError(e);
              res.sendFile(path.join(__dirname, 'lib', 'output', 'no-stats', 'index.html'));
            });
        })
        .catch(e => {
          this.ui.writeError(e);
        });
    });
  },

  computeOutput() {
    if (!this._computePromise) {
      debug('Computing stats...');
      this._computePromise = summarizeAll(this.concatStatsPath, this.ignoredFiles)
        .then(() => {
          debug('Computing finished.');
          this._computePromise = null;
          return createOutput(this.concatStatsPath);
        });
    }
    return this._computePromise;
  },

  initBuildWatcher() {
    let resolve;
    let initialResolve;
    if (this._buildWatcher) {
      return;
    }
    this._initialBuildPromise = new Promise((_resolve) => initialResolve = _resolve);
    this._buildWatcher = interceptStdout((text) => {
      if (text instanceof Buffer) {
        text = text.toString();
      }
      if (typeof text !== 'string') {
        return text;
      }

      if (text.match(/file (added|changed|deleted)/)) {
        debug('Rebuild detected');
        this._buildPromise = new Promise((_resolve) => resolve = _resolve);
      }

      if (text.match(/Build successful/)) {
        debug('Finished build detected');
        setTimeout(() => {
          resolve();
          initialResolve();
        }, 1000);
      }
    });
  },

  initWatcher() {
    if (this._hasWatcher) {
      return;
    }
    debug('Initializing watcher on json files');
    let watcher = sane(this.concatStatsPath, { glob: ['*.json'], ignored: ['*.out.json'] });
    watcher.on('change', this._handleWatcher.bind(this));
    watcher.on('add', this._handleWatcher.bind(this));
    watcher.on('delete', this._handleWatcher.bind(this));
    this._hasWatcher = true;
  },

  _handleWatcher(filename, root/*, stat*/) {
    let file = path.join(root, filename);
    let hash = hashFiles({ files: [file] });

    if (this._hashedFiles[filename] !== hash) {
      debug(`Cache invalidated by ${filename}`);
      this._statsOutput = null;
      this._hashedFiles[filename] = hash;
    }
  },

  isEnabled() {
    return true;
  },

  hasStats() {
    return !!process.env.CONCAT_STATS && this.concatStatsPath && fs.existsSync(this.concatStatsPath);
  },

  enableStats() {
    debug('Enabled stats generation');
    process.env.CONCAT_STATS = 'true';
  },

  triggerBuild() {
    debug('Triggering build');
    let mainFile = this.getMainFile();
    if (mainFile) {
      debug(`Touching ${mainFile}`);
      touch(mainFile);
    } else {
      throw new Error('No main file found to trigger build');
    }
  },

  getMainFile() {
    let { root } = this.project;
    let mainCandidates = [
      'app/app.js', // app
      'src/main.js', // MU
      'tests/dummy/app/app.js', // addon dummy app
      'app/app.ts', // app (TS)
      'src/main.ts', // MU (TS)
      'tests/dummy/app/app.ts' // addon dummy app (TS)
    ]
      .map((item) => path.join(root, item));

    for (let mainFile of mainCandidates) {
      if (fs.existsSync(mainFile)) {
        return mainFile
      }
    }
  }
};
