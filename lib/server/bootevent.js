import _ from 'lodash';
import url from 'url';
import request from 'request';
import openapsStorage from '../storage/openaps-storage';
import authorization_ from '../authorization';
import mongoStorage from '../storage/mongo-storage';
import semver from 'semver';
import levels from '../levels';
import plugins from '../plugins';
import pushover from '../plugins/pushover';
import maker from '../plugins/maker';
import pushnotify from './pushnotify.js';
import activity from './activity.js';
import entries from './entries.js';
import treatments from './treatments.js';
import devicestatus from './devicestatus.js';
import profile from './profile.js';
import food from './food.js';
import pebble from './pebble.js';
import properties from '../api/properties';
import bus from '../bus';
import dataloader from '../data/dataloader';
import ddata from '../data/ddata';
import notifications from '../notifications';
import alexa from '../plugins/alexa';
import sandbox from '../sandbox';

import bridge from '../plugins/bridge';
import mmconnect from '../plugins/mmconnect';
import bootevent from 'bootevent';

var UPDATE_THROTTLE = 5000;

function boot (env, language) {

  //////////////////////////////////////////////////
  // Check Node version. 
  // Latest Node 8 LTS and Latest Node 10 LTS are recommended and supported. 
  // Latest Node version on Azure is tolerated, but not recommended
  // Latest Node (non LTS) version works, but is not recommended
  // Older Node versions or Node versions with known security issues will not work.
  // More explicit:
  // < 8        does not work, not supported
  // >= 8.15.1  works, supported and recommended
  // == 9.x     does not work, not supported
  // == 10.15.2 works, not fully supported and not recommended (Azure version)
  // >= 10.16.0 works, supported and recommended
  // == 11.x    does not work, not supported
  // >= 12.6.0  does work, not recommended, will not be supported. We only support Node LTS releases
  ///////////////////////////////////////////////////
  function checkNodeVersion (ctx, next) {
    var nodeVersion = process.version;

    if ( semver.satisfies(nodeVersion, '^8.15.1') || semver.satisfies(nodeVersion, '^10.16.0')) {
      //Latest Node 8 LTS and Latest Node 10 LTS are recommended and supported.
      //Require at least Node 8 LTS and Node 10 LTS without known security issues
      console.debug('Node LTS version ' + nodeVersion + ' is supported');
      next();
    }
    else if ( semver.eq(nodeVersion, '10.15.2')) {
      next();
    }
    else if (semver.satisfies(nodeVersion, '^12.6.0')) {
        //Latest Node version
        console.debug('Node version ' + nodeVersion + ' is not a LTS version. Not recommended. Not supported');
        next();
    }
  }


  function checkEnv (ctx, next) {
    ctx.language = language;
    if (env.err) {
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'ENV Error', err: env.err});
    }
    next();
  }

  function hasBootErrors(ctx) {
    return ctx.bootErrors && ctx.bootErrors.length > 0;
  }

  function augmentSettings (ctx, next) {
    var configURL = env.IMPORT_CONFIG || null;
    var href = null;
    try {
      href = url.parse(configURL).href;
    } catch (e) {/**/}
    if(configURL && href) {
      request.get({url: href, json: true}, function (err, resp, body) {
        if (err) {
          throw err;
        } else {
          var {
            settings = body
          } = body;
          _.merge(env.settings, settings);
          if (body.extendedSettings) {
            _.merge(env.extendedSettings, body.extendedSettings);
          }
        }
        next( );
      });
    } else {
      next( );
    }
  }

  function setupStorage (ctx, next) {

    if (hasBootErrors(ctx)) {
      return next();
    }

    try {
      if (_.startsWith(env.storageURI, 'openaps://')) {
        openapsStorage (env, function ready (err, store) {
          if (err) {
            throw err;
          }

          ctx.store = store;
          next();
        });
      } else {
        //TODO assume mongo for now, when there are more storage options add a lookup
        mongoStorage(env, function ready(err, store) {
          ctx.store = store;

          next();
        });
      }
    } catch (err) {
      console.info('mongo err', err);
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'Unable to connect to Mongo', err: err});
      next();
    }
  }

  function setupAuthorization (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.authorization = authorization_(env, ctx);
    ctx.authorization.storage.reload(function loaded (err) {
      if (err) {
        ctx.bootErrors = ctx.bootErrors || [ ];
        ctx.bootErrors.push({'desc': 'Unable to setup authorization', err: err});
      }
      next();
    });
  }

  function setupInternals (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.levels = levels;
    ctx.levels.translate = ctx.language.translate;

    ///////////////////////////////////////////////////
    // api and json object variables
    ///////////////////////////////////////////////////
    ctx.plugins = plugins ({
      settings: env.settings
      , language: ctx.language
    }).registerServerDefaults();

    ctx.pushover =pushover(env);
    ctx.maker = maker(env);
    ctx.pushnotify =pushnotify(env, ctx);

    ctx.activity =activity(env, ctx);
    ctx.entries = entries(env, ctx);

    ctx.treatments = treatments(env, ctx);
    ctx.devicestatus = devicestatus(env.devicestatus_collection, ctx);
    ctx.profile = profile(env.profile_collection, ctx);
    ctx.food = food(env, ctx);
    ctx.pebble = pebble(env, ctx);
    ctx.properties = properties(env, ctx);
    ctx.bus = bus(env.settings, ctx);
    ctx.ddata = ddata();
    ctx.dataloader = dataloader(env, ctx);
    ctx.notifications = notifications(env, ctx);

    if (env.settings.isEnabled('alexa')) {
      ctx.alexa = alexa(env, ctx);
    }

    next( );
  }

  function ensureIndexes (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    console.info('Ensuring indexes');
    ctx.store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
    ctx.store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
    ctx.store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
    ctx.store.ensureIndexes(ctx.profile( ), ctx.profile.indexedFields);
    ctx.store.ensureIndexes(ctx.food( ), ctx.food.indexedFields);
    ctx.store.ensureIndexes(ctx.activity( ), ctx.activity.indexedFields);

    next( );
  }

  function setupListeners (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    var updateData = _.debounce(function debouncedUpdateData ( ) {
      ctx.dataloader.update(ctx.ddata, function dataUpdated () {
        ctx.bus.emit('data-loaded');
      });
    }, UPDATE_THROTTLE);

    ctx.bus.on('tick', function timedReloadData (tick) {
      console.info('tick', tick.now);
      updateData();
    });

    ctx.bus.on('data-received', function forceReloadData ( ) {
      console.info('got data-received event, requesting reload');
      updateData();
    });

    ctx.bus.on('data-loaded', function updatePlugins ( ) {
      console.info('reloading sandbox data');
      var sbx =sandbox().serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      ctx.notifications.initRequests();
      ctx.plugins.checkNotifications(sbx);
      ctx.notifications.process(sbx);
      ctx.bus.emit('data-processed');
    });

    ctx.bus.on('notification', ctx.pushnotify.emitNotification);

    next( );
  }

  function setupBridge (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }


    ctx.bridge = bridge(env);
    if (ctx.bridge) {
      ctx.bridge.startEngine(ctx.entries);
    }
    next( );
  }

  function setupMMConnect (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.mmconnect = mmconnect.init(env, ctx.entries, ctx.devicestatus);
    if (ctx.mmconnect) {
      ctx.mmconnect.run();
    }
    next( );
  }

  function finishBoot (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.bus.uptime( );

    next( );
  }

  return bootevent( )
    .acquire(checkNodeVersion)
    .acquire(checkEnv)
    .acquire(augmentSettings)
    .acquire(setupStorage)
    .acquire(setupAuthorization)
    .acquire(setupInternals)
    .acquire(ensureIndexes)
    .acquire(setupListeners)
    .acquire(setupBridge)
    .acquire(setupMMConnect)
    .acquire(finishBoot);
}

export default boot;
