'use strict';
const resolve = require("rollup-plugin-node-resolve");
const commonjs = require("rollup-plugin-commonjs");

const {
  terser
} = require("rollup-plugin-terser");

const svelte = require("rollup-plugin-svelte");
const postcss = require("rollup-plugin-postcss");
const json = require("rollup-plugin-json");
const nodeBuiltins = require("rollup-plugin-node-builtins");
const globals = require('rollup-plugin-node-globals');
const inject = require('rollup-plugin-inject');

// `rollup -c` -> `production` is true
// `rollup -c -w` -> `production` is false
const production = !process.env.ROLLUP_WATCH;

const inputs = [
  {
    input: "bundle/bundle.source.js",
    output: {
      file: "tmp/js/bundle.app.js",
      name: "app",
      format: "umd",
      sourcemap: true
    }
  },

  {
    input: "bundle/bundle.clocks.source.js",
    output: {
      file: "tmp/js/bundle.clock.js",
      name: "clock",
      format: "umd",
      sourcemap: true
    }
  },
  {
    input: "bundle/bundle.reports.source.js",
    output: {
      file: "tmp/js/bundle.report.js",
      name: "report",
      format: "umd",
      sourcemap: true
    }
  }
];

const defaults = {
  plugins: [
    svelte(),
    json(),
    resolve({
      mainFields: ['module', 'browser', 'main'],
      preferBuiltins: true
    }), 
    postcss({
      plugins: []
    }),
    commonjs({
      nested: true,
      include: '**',
    }),
    inject({
      include: '**',
      modules: {
        $: 'jquery',
        jQuery: 'jquery',
      }
    }),
    nodeBuiltins({
    }),
    globals(),
    production && terser(), // minify, but only in production
  ]
};

module.exports = inputs.map(config => ({ ...defaults, ...config }));
