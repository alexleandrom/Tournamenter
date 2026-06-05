const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const async = require('async');
const concat = require('concat-files');
const UglifyJS = require('uglify-js');
const CleanCSS = require('clean-css');

const Loader = require('../helpers/loader');

const TAG = chalk.yellow('[BUILD]');

module.exports = function build(BUILD_PATH, assets, next){
  const DIR_JS = path.join(BUILD_PATH, 'js');
  const DIR_CSS = path.join(BUILD_PATH, 'css');

  const BUILD_JS = '/modules.js';
  const BUILD_JS_MAP = '/modules.js.map';

  const BUILD_JST = '/modules.jst.js';

  const BUILD_CSS = '/modules.css';
  const BUILD_CSS_MIN = '/modules.min.css';
  const BUILD_CSS_MIN_MAP = '/modules.min.css.map';

  const TIME_START = Date.now();

  async.autoInject({

    // Erase build folder
    clear: (next) => {
      console.log(TAG, `clear ${BUILD_PATH}`)
      // fs.emptyDirSync(BUILD_PATH);
      fs.emptyDirSync(DIR_JS);
      fs.emptyDirSync(DIR_CSS);
      next();
    },

    // Load modules
    // modules: (clear, next) => {
    //   var modules = app.helpers.Modules.modules;
    //   console.log(TAG, `load modules`, chalk.yellow(`[${_.keys(modules).length}]`));
    //
    //   next(null, modules)
    // },

    // Find out witch assets to merge
    injectAssets: (clear, next) => {
      console.log(TAG, `inject assets`);

      next(null, assets);
    },

    // Read templates
    readTemplates: (injectAssets, next) => {
      console.log(TAG, `readTemplates`);
      async.mapLimit(injectAssets.jst, 10, readFile, next);

      function readFile(fileName, next) {
        fs.readFile(fileName, (err, file) => {
          if(err) return next(err);

          next(null, {
            name: path.basename(fileName, '.html'),
            body: file.toString(),
          })
        })
      }
    },

    // Build JST templates
    buildTemplates: (readTemplates, next) => {
      console.log(TAG, `buildTemplates`);

      // Configure template rendering
      var templateSettings = {
        interpolate: /\{\{(.+?)\}\}/g
      };

      // Initial template definition
      var header = '\n\n;this["JST"] = this["JST"] || {};';

      // Merge all
      var jst = [header, ..._.map(readTemplates, compile, next)];
      next(null, jst.join('\n\n'));

      function compile(file){
        var tpl = `this["JST"]["${file.name}"] = `;
        tpl += _.template(file.body, templateSettings, false).source + ';';
        return tpl;
      }
    },

    // Save JST template file
    saveTemplates: (buildTemplates, next) => {
      console.log(TAG, `saveTemplates`);
      fs.writeFile(DIR_JS + BUILD_JST, buildTemplates, next);
    },

    // Concat and minify JS
    // UglifyJS v3: requer objeto {filename: source} em vez de array de caminhos
    concatJs: (injectAssets, next) => {
      console.log(TAG, `concatJs`);

      const filesMap = {};
      for (const filePath of injectAssets.js) {
        try {
          filesMap[path.basename(filePath)] = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
          return next(new Error(`Failed to read JS file: ${filePath} — ${e.message}`));
        }
      }

      var result = UglifyJS.minify(filesMap, {
        sourceMap: {
          filename: 'modules.js',
          url: 'modules.js.map',
        }
      });

      if (result.error) return next(result.error);
      next(null, result);
    },

    // Concat and minify CSS
    concatCss: (injectAssets, next) => {
      console.log(TAG, `buildCss`);
      concat(injectAssets.css, DIR_CSS + BUILD_CSS, next);
    },

    // Minify CSS
    // CleanCSS v5+: síncrono, sem callback; sourceMap retorna SourceMapGenerator
    minifyCss: (concatCss, next) => {
      console.log(TAG, `minifyCss`);

      const input = fs.readFileSync(DIR_CSS + BUILD_CSS);
      const output = new CleanCSS({ sourceMap: true }).minify(input);

      if (output.errors && output.errors.length > 0) {
        return next(new Error(output.errors.join('\n')));
      }

      next(null, output);
    },

    // Save JS to file
    save: (concatJs, minifyCss, next) => {
      console.log(TAG, `save`);

      fs.writeFileSync(DIR_JS + BUILD_JS, concatJs.code);
      fs.writeFileSync(DIR_JS + BUILD_JS_MAP, concatJs.map);

      fs.writeFileSync(DIR_CSS + BUILD_CSS_MIN, minifyCss.styles);
      // sourceMap pode ser SourceMapGenerator (objeto) em versões novas — converter para string
      const cssMap = minifyCss.sourceMap;
      fs.writeFileSync(DIR_CSS + BUILD_CSS_MIN_MAP,
        typeof cssMap === 'string' ? cssMap : cssMap.toString());

      next();
    },

  }, (err, results) => {
    if(err) return next(err);

    console.log(TAG, `build took ${Date.now() - TIME_START} ms`);
    next();
  })
}
//
// module.exports((err) => {
//   console.log('Completed', err);
// })
