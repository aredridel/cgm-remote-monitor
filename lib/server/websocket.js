import levels from '../levels';
import times from '../times';
import calcData from '../data/calcdelta';
import {ObjectID} from 'mongodb';
import socketio from 'socket.io';

function init (env, ctx, server) {
  function websocket ( ) {
    return websocket;
  }

  //var log_yellow = '\x1B[33m';
  var log_green = '\x1B[32m';
  var log_reset = '\x1B[0m';
  var LOG_WS = log_green + 'WS: ' + log_reset;

  var io;
  var watchers = 0;
  var lastData = {};
  var lastProfileSwitch = null;

  // TODO: this would be better to have somehow integrated/improved
  var supportedCollections = {
  'treatments' : env.treatments_collection,
  'entries': env.entries_collection,
  'devicestatus': env.devicestatus_collection, 
  'profile': env.profile_collection, 
  'food': env.food_collection,
  'activity': env.activity_collection
  };

  // This is little ugly copy but I was unable to pass testa after making module from status and share with /api/v1/status
  // eslint-disable-next-line no-unused-vars
  function status() {
    var versionNum = 0;
    var verParse = /(\d+)\.(\d+)\.(\d+)*/.exec(env.version);
    if (verParse) {
      versionNum = 10000 * parseInt(verParse[1]) + 100 * parseInt(verParse[2]) + 1 * parseInt(verParse[3]) ;
    }
    var apiEnabled = env.api_secret ? true : false;

    var activeProfile = ctx.ddata.lastProfileFromSwitch;

    var info = {
      status: 'ok'
      , name: env.name
      , version: env.version
      , versionNum: versionNum
      , serverTime: new Date().toISOString()
      , apiEnabled: apiEnabled
      , careportalEnabled: apiEnabled && env.settings.enable.indexOf('careportal') > -1
      , boluscalcEnabled: apiEnabled && env.settings.enable.indexOf('boluscalc') > -1
      , settings: env.settings
      , extendedSettings: ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {}
    };

    if (activeProfile) {
      info.activeProfile = activeProfile;
    }
    return info;
  }

  function start ( ) {
    io = socketio({
      'transports': ['xhr-polling'], 'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      'browser client minification': true,
      'browser client etag': true,
      'browser client gzip': false
    });
  }

  function verifyAuthorization (message, callback) {
    ctx.authorization.resolve({ api_secret: message.secret, token: message.token }, function resolved (err, result) {

      if (err) {
        return callback( err, {
          read: false
          , write: false
          , write_treatment: false
        });
      }

      return callback(null, {
        read: ctx.authorization.checkMultiple('api:*:read', result.shiros)
        , write: ctx.authorization.checkMultiple('api:*:create,update,delete', result.shiros)
        , write_treatment: ctx.authorization.checkMultiple('api:treatments:create,update,delete', result.shiros)
      });
    });
  }

  function emitData (delta) {
    if (lastData.cals) {
      if (lastProfileSwitch !== ctx.ddata.lastProfileFromSwitch) {
        delta.status = status(ctx.ddata.profiles);
        lastProfileSwitch = ctx.ddata.lastProfileFromSwitch;
      }
      io.to('DataReceivers').emit('dataUpdate', delta);
    }
  }

  function listeners ( ) {
    io.sockets.on('connection', function onConnection (socket) {
      var socketAuthorization = null;
      var history;

      io.emit('clients', ++watchers);
      socket.on('ack', function onAck(level, group, silenceTime) {
        ctx.notifications.ack(level, group, silenceTime, true);
      });

      socket.on('disconnect', function onDisconnect ( ) {
        io.emit('clients', --watchers);
      });


      function checkConditions (action, data) {
        var collection = supportedCollections[data.collection];
        if (!collection) {
          return { result: 'Wrong collection' };
        }

        if (!socketAuthorization) {
          return { result: 'Not authorized' };
        }

        if (data.collection === 'treatments') {
          if (!socketAuthorization.write_treatment) {
            return { result: 'Not permitted' };
          }
        } else {
          if (!socketAuthorization.write) {
            return { result: 'Not permitted' };
          }
        }

        if (action === 'dbUpdate' && !data._id) {
          return { result: 'Missing _id' };
        }

        return null;
      }

      socket.on('loadRetro', function loadRetro (opts, callback) {
        if (callback) {
          callback( { result: 'success' } );
        }
        //TODO: use opts to only send delta for retro data
        socket.emit('retroUpdate', {devicestatus: lastData.devicestatus});
        console.info('sent retroUpdate', opts);
      });

      // dbUpdate message
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbUpdate', function dbUpdate (data, callback) {
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }
        var id ;
        try {
            id = new ObjectID(data._id);
        } catch (err){
          id = new ObjectID();
        }
        ctx.store.collection(collection).update(
          { '_id': id },
          { $set: data.data }
        );

        if (callback) {
          callback( { result: 'success' } );
        }
        ctx.bus.emit('data-received');
      });

      // dbUpdateUnset message
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //    data: {
      //      field_1: 1,
      //      field_2: 1
      //    }
      //  }
      socket.on('dbUpdateUnset', function dbUpdateUnset (data, callback) {
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }

        var objId = new ObjectID(data._id);
        ctx.store.collection(collection).update(
          { '_id': objId },
          { $unset: data.data }
        );

        if (callback) {
          callback( { result: 'success' } );
        }
        ctx.bus.emit('data-received');
      });

      // dbAdd message
      //  {
      //    collection: treatments
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbAdd', function dbAdd (data, callback) {
        var collection = supportedCollections[data.collection];
        var maxtimediff = times.mins(1).msecs;

        var check = checkConditions('dbAdd', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }

        if (data.collection === 'treatments' && !('eventType' in data.data)) {
          data.data.eventType = '<none>';
        }
        if (!('created_at' in data.data)) {
          data.data.created_at = new Date().toISOString();
        }

        // treatments deduping
        if (data.collection === 'treatments') {
          var query;
          if (data.data.NSCLIENT_ID) {
            query = { NSCLIENT_ID:  data.data.NSCLIENT_ID };
          } else {
            query = {
              created_at: data.data.created_at
              , eventType: data.data.eventType
            };
          }

         // try to find exact match
          ctx.store.collection(collection).find(query).toArray(function findResult (err, array) {
            if (err || array.length > 0) {
              if (callback) {
                callback([array[0]]);
              }
              return;
            }

            var  selected = false;
            var query_similiar  = {
              created_at: {$gte: new Date(new Date(data.data.created_at).getTime() - maxtimediff).toISOString(), $lte: new Date(new Date(data.data.created_at).getTime() + maxtimediff).toISOString()}
            };
            if (data.data.insulin) {
              query_similiar.insulin = data.data.insulin;
              selected = true;
            }
            if (data.data.carbs) {
              query_similiar.carbs = data.data.carbs;
              selected = true;
            }
            if (data.data.percent) {
              query_similiar.percent = data.data.percent;
              selected = true;
            }
             if (data.data.absolute) {
              query_similiar.absolute = data.data.absolute;
              selected = true;
            }
            if (data.data.duration) {
              query_similiar.duration = data.data.duration;
              selected = true;
            }
             if (data.data.NSCLIENT_ID) {
              query_similiar.NSCLIENT_ID = data.data.NSCLIENT_ID;
              selected = true;
            }
            // if none assigned add at least eventType
            if (!selected) {
              query_similiar.eventType = data.data.eventType;
            }
            // try to find similiar
            ctx.store.collection(collection).find(query_similiar).toArray(function findSimiliarResult (err, array) {
              // if found similiar just update date. next time it will match exactly
              if (err || array.length > 0) {
                array[0].created_at = data.data.created_at;
                var objId = new ObjectID(array[0]._id);
                ctx.store.collection(collection).update(
                  { '_id': objId },
                  { $set: {created_at: data.data.created_at} }
                );
                if (callback) {
                  callback([array[0]]);
                }
                ctx.bus.emit('data-received');
                return;
              }
              ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
                if (err != null && err.message) {
                  return;
                }
                if (callback) {
                  callback(doc.ops);
                }
                ctx.bus.emit('data-received');
              });
            });
          });
        // devicestatus deduping
        } else if (data.collection === 'devicestatus') {
          var queryDev;
          if (data.data.NSCLIENT_ID) {
            queryDev = { NSCLIENT_ID: data.data.NSCLIENT_ID };
          } else {
            queryDev = {
              created_at: data.data.created_at
            };
          }

          // try to find exact match
          ctx.store.collection(collection).find(queryDev).toArray(function findResult (err, array) {
            if (err || array.length > 0) {
              if (callback) {
                callback([array[0]]);
              }
              return;
            }
          });
          ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
            if (err != null && err.message) {
              return;
            }
            if (callback) {
            callback(doc.ops);
            }
            ctx.bus.emit('data-received');
          });
        } else {
          ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
            if (err != null && err.message) {
              return;
            }
            if (callback) {
              callback(doc.ops);
            }
            ctx.bus.emit('data-received');
          });
        }
      });
      // dbRemove message
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //  }
      socket.on('dbRemove', function dbRemove (data, callback) {
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }

        var objId = new ObjectID(data._id);
        ctx.store.collection(collection).remove(
          { '_id': objId }
        );

        if (callback) {
          callback( { result: 'success' } );
        }
        ctx.bus.emit('data-received');
      });

      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'
      //  , secret: 'secret_hash'
      //  [, history : history_in_hours ]
      //  [, status : true ]
      // }
      socket.on('authorize', function authorize (message, callback) {
        verifyAuthorization(message, function verified (err, authorization) {
          socketAuthorization = authorization;
          history = message.history || 48; //default history is 48 hours
          var {
            from
          } = message;

          if (socketAuthorization.read) {
            socket.join('DataReceivers');
            var filterTreatments = false;
            var msecHistory = times.hours(history).msecs;
            // if `from` is received, it's a reconnection and full data is not needed
            if (from && from > 0) {
              filterTreatments = true;
              msecHistory = Math.min(new Date().getTime() - from, msecHistory);
            }
            // send all data upon new connection
            if (lastData && lastData.splitRecent) {
              var split = lastData.splitRecent(Date.now(), times.hours(3).msecs, msecHistory, filterTreatments);
              if (message.status) {
                split.first.status = status(split.first.profiles);
              }
              //send out first chunk
              socket.emit('dataUpdate', split.first);

              //then send out the rest
              setTimeout(function sendTheRest() {
                split.rest.delta = true;
                socket.emit('dataUpdate', split.rest);
              }, 500);
            }
          }
          if (callback) {
            callback(socketAuthorization);
          }
        });
      });

      // Pind message
      // {
      //  mills: <local_time_in_milliseconds>
      // }
      socket.on('nsping', function ping (message, callback) {
        if (callback) {
          callback({ result: 'pong', mills: new Date().getTime(), authorization: socketAuthorization });
        }
      });
    });
  }

  websocket.update = function update ( ) {
    if (lastData.sgvs) {
      var delta = calcData(lastData, ctx.ddata);
      if (delta.delta) {
        delta.sgvs;
        emitData(delta);
      }
    }
    lastData = ctx.ddata.clone();
  };

  websocket.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      io.emit('clear_alarm', notify);
      console.info(LOG_WS + 'emitted clear_alarm to all clients');
    } else if (notify.level === levels.WARN) {
      io.emit('alarm', notify);
      console.info(LOG_WS + 'emitted alarm to all clients');
    } else if (notify.level === levels.URGENT) {
      io.emit('urgent_alarm', notify);
      console.info(LOG_WS + 'emitted urgent_alarm to all clients');
    } else if (notify.isAnnouncement) {
      io.emit('announcement', notify);
      console.info(LOG_WS + 'emitted announcement to all clients');
    } else {
      io.emit('notification', notify);
      console.info(LOG_WS + 'emitted notification to all clients');
    }
  };

  start( );
  listeners( );

  if (ctx.storageSocket) {
    ctx.storageSocket.init(io);
  }

  return websocket();
}

export default init;
