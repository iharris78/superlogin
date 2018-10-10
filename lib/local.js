'use strict';
var util = require('./util');
var LocalStrategy = require('passport-local');
var BearerStrategy = require('passport-http-bearer-sl').Strategy;
var PouchDB = require('pouchdb');


module.exports = function (config, passport, user, userDB) {

  // API token strategy
  passport.use(new BearerStrategy(
    function (tokenPass, done) {
      var parse = tokenPass.split(':');
      if(parse.length < 2) {
        done(null, false, {message: 'invalid token'});
      }
      var token = parse[0];
      var password = parse[1];
      user.confirmSession(token, password)
        .then(function (theuser) {
          done(null, theuser);
        }, function (err) {
          if (err instanceof Error) {
            done(err, false);
          } else {
            done(null, false, {message: err});
          }
        });
    }
  ));

  // Use local strategy
  passport.use(new LocalStrategy({
      usernameField: config.getItem('local.usernameField') || 'username',
      passwordField: config.getItem('local.passwordField') || 'password',
      session: false,
      passReqToCallback: true
    },
    function (req, username, password, done) {
      var realm = req.headers.realm;
      var userDB = new PouchDB(util.getFullDBURL(config.getItem('dbServer'), 'users_' + realm));
      var recordPromise = null;
      if(username.indexOf('@') > 0){
        recordPromise = userDB.query('auth/email', {key: username, include_docs: true});
      } else {
        //recordPromise = user.get(username);
        recordPromise = userDB.query('auth/username', {key: username, include_docs: true});
      }
      recordPromise
        .then(function(queryRes){
          if(queryRes.rows.length > 0){
            return queryRes.rows[0].doc;
          } else {
            return null;
          }

        })
        .then(function (theuser) {
          if (theuser) {
            // Check if the account is locked
            if(theuser.local && theuser.local.lockedUntil && theuser.local.lockedUntil > Date.now()) {
              return done(null, false, {
                error: 'Unauthorized',
                message: 'Your account is currently locked. Please wait a few minutes and try again.'
              });
            }
            if(!theuser.local || !theuser.local.derived_key) {
              return done(null, false, {
                error: 'Unauthorized',
                message: 'Invalid username or password'
              });
            }
            util.verifyPassword(theuser.local, password)
              .then(function () {
                // Check if the email has been confirmed if it is required
                if(config.getItem('local.requireEmailConfirm') && !theuser.email) {
                  return done(null, false, {
                    error: 'Unauthorized',
                    message: 'You must confirm your email address.'
                  });
                }
                // Success!!!
                return done(null, theuser);
              }, function (err) {
                if (!err) {
                  // Password didn't authenticate
                  return handleFailedLogin(theuser, req, done);
                } else {
                  // Hashing function threw an error
                  return done(err);
                }
              });
          } else {
            // user not found
            return done(null, false, {
              error: 'Unauthorized',
              message: 'Invalid username or password'
            });
          }
        }, function (err) {
          // Database threw an error
          return done(err);
        });
    }
  ));

  function handleFailedLogin(userDoc, req, done) {
    var invalid = {
      error: 'Unauthorized',
      message: 'Invalid username or password'
    };
    return req.userObject.handleFailedLogin(userDoc, req)
      .then(function(locked) {
        if(locked) {
          invalid.message = 'Maximum failed login attempts exceeded. Your account has been locked for ' +
              Math.round(config.getItem('security.lockoutTime') / 60) + ' minutes.';
        }
        return done(null, false, invalid);
      });
  }

};
