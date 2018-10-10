'use strict';
var util = require('./util');
var PouchDB = require('pouchdb');
var User = require('./user');

module.exports = function(config, router, passport, user, couchAuthDB, mailer, emitter, onCreateActions, onLinkActions, adapter) {

  var env = process.env.NODE_ENV || 'development';

  router.use(function(req, res, next){
    var realm = req.headers.realm;
    console.log('Using realm : ' + realm);
    //var userDB = new PouchDB(util.getFullDBURL(config.getItem('dbServer'), config.getItem('dbServer.userDB')));
    var userDB = new PouchDB(util.getFullDBURL(config.getItem('dbServer'), 'users_' + realm));
    //req.userObject = user;
    req.userObject = new User(config, userDB, couchAuthDB, mailer, emitter, onCreateActions, onLinkActions, adapter);
    next();
  });

  router.post('/login', function(req, res, next) {
    passport.authenticate('local', function(err, user, info) {
      if(err) {
        return next(err);
      }
      if(!user) {
        // Authentication failed
        return res.status(401).json(info);
      }
      // Success
      req.logIn(user, {session: false}, function(err) {
        if (err) {
          return next(err);
        }
      });
      return next();
    })(req, res, next);
    }, function (req, res, next) {
      // Success handler
      return req.userObject.createSession(req.user._id, req.headers.realm, 'local', req)
        .then(function (mySession) {
          res.status(200).json(mySession);
        }, function (err) {
          return next(err);
        });
    });

  router.post('/refresh',
    passport.authenticate('bearer', {session: false}),
    function (req, res, next) {
      return req.userObject.refreshSession(req.user.key)
        .then(function (mySession) {
          res.status(200).json(mySession);
        }, function (err) {
          return next(err);
        });
    });

  router.post('/logout',
    function (req, res, next) {
      var sessionToken = util.getSessionToken(req);
      if(!sessionToken) {
        return next({
          error: 'unauthorized',
          status: 401
        });
      }
      req.userObject.logoutSession(sessionToken)
        .then(function () {
          res.status(200).json({ok: true, success: 'Logged out'});
        }, function (err) {
          console.error('Logout failed');
          return next(err);
        });
    });

  router.post('/logout-others',
    passport.authenticate('bearer', {session: false}),
    function (req, res, next) {
      req.userObject.logoutOthers(req.user.key)
        .then(function () {
          res.status(200).json({success: 'Other sessions logged out'});
        }, function (err) {
          console.error('Logout failed');
          return next(err);
        });
    });

  router.post('/logout-all',
    function (req, res, next) {
      var sessionToken = util.getSessionToken(req);
      if(!sessionToken) {
        return next({
          error: 'unauthorized',
          status: 401
        });
      }
      req.userObject.logoutUser(null, sessionToken)
        .then(function () {
          res.status(200).json({success: 'Logged out'});
        }, function (err) {
          console.error('Logout-all failed');
          return next(err);
        });
    });

  // Setting up the auth api
  router.post('/register', function (req, res, next) {
    req.userObject.create(req.body, req)
        .then(function (newUser) {
          if(config.getItem('security.loginOnRegistration')) {
            return req.userObject.createSession(newUser._id, req.headers.realm, 'local', req.ip)
              .then(function (mySession) {
                res.status(200).json(mySession);
              }, function (err) {
                console.log('error on registration login');
                return next(err);
              });
          } else {
            res.status(201).json({success: 'User created.'});
          }
        }, function (err) {
          return next(err);
        });
    });

  router.post('/forgot-password', function (req, res, next) {
    req.userObject.forgotPassword(req.body.email, req).then(function () {
        res.status(200).json({success: 'Password recovery email sent.'});
      }, function (err) {
        return next(err);
      });
    });

  router.post('/password-reset', function (req, res, next) {
    req.userObject.resetPassword(req.body, req)
        .then(function (currentUser) {
          if(config.getItem('security.loginOnPasswordReset')) {
            return req.userObject.createSession(currentUser._id, req.headers.realm, 'local', req.ip)
              .then(function (mySession) {
                res.status(200).json(mySession);
              }, function (err) {
                return next(err);
              });
          } else {
            res.status(200).json({success: 'Password successfully reset.'});
          }
        }, function (err) {
          return next(err);
        });
    });

  router.post('/password-change',
    passport.authenticate('bearer', {session: false}),
    function (req, res, next) {
      req.userObject.changePasswordSecure(req.user._id, req.body, req)
        .then(function () {
          res.status(200).json({success: 'password changed'});
        }, function (err) {
          return next(err);
        });
    });

  router.post('/unlink/:provider',
    passport.authenticate('bearer', {session: false}),
    function(req, res, next) {
      var provider = req.params.provider;
      req.userObject.unlink(req.user._id, provider)
        .then(function() {
          res.status(200).json({success: util.capitalizeFirstLetter(provider) + ' unlinked'});
        }, function (err) {
          return next(err);
        });
    });

  router.get('/confirm-email/:realm/:token', function (req, res, next) {
    var redirectURL = config.getItem('local.confirmEmailRedirectURL');
    var userDB = new PouchDB(util.getFullDBURL(config.getItem('dbServer'), 'users_' + req.params.realm));
    var userObject = new User(config, userDB, couchAuthDB, mailer, emitter, onCreateActions, onLinkActions);
    if (!req.params.token) {
      var err = {error: 'Email verification token required'};
      if(redirectURL) {
        return res.status(201).redirect(redirectURL + '?error=' + encodeURIComponent(err.error));
      }
      return res.status(400).send(err);
    }
    userObject.verifyEmail(req.params.token, req).then(function () {
      if(redirectURL) {
        return res.status(201).redirect(redirectURL + '?success=true');
      }
      res.status(200).send({ok: true, success: 'Email verified'});
    }, function (err) {
      if(redirectURL) {
        var query = '?error=' + encodeURIComponent(err.error);
        if(err.message) {
          query += '&message=' + encodeURIComponent(err.message);
        }
        return res.status(201).redirect(redirectURL + query);
      }
      return next(err);
    });
  });

  router.get('/validate-username/:username',
    function(req, res, next) {
      if(!req.params.username) {
        return next({error: 'Username required', status: 400});
      }
      req.userObject.validateUsername(req.params.username)
        .then(function(err) {
          if(!err) {
            res.status(200).json({ok: true});
          } else {
            res.status(409).json({error: 'Username already in use'});
          }
        }, function(err) {
          return next(err);
        });
    }
  );

  router.get('/validate-email/:email',
    function(req, res, next) {
      var promise;
      if(!req.params.email) {
        return next({error: 'Email required', status: 400});
      }
      if(config.getItem('local.emailUsername')) {
        promise = req.userObject.validateEmailUsername(req.params.email);
      } else {
        promise = req.userObject.validateEmail(req.params.email);
      }
      promise
        .then(function(err) {
          if(!err) {
            res.status(200).json({ok: true});
          } else {
            res.status(409).json({error: 'Email already in use'});
          }
        }, function(err) {
          return next(err);
        });
    }
  );

  router.post('/change-email',
    passport.authenticate('bearer', {session: false}),
    function (req, res, next) {
      req.userObject.changeEmail(req.user._id, req.body.newEmail, req)
        .then(function () {
          res.status(200).json({ok: true, success: 'Email changed'});
        }, function (err) {
          return next(err);
        });
    });

  // route to test token authentication
  router.get('/session',
    passport.authenticate('bearer', {session: false}),
    function (req, res) {
      var user = req.user;
      user.user_id = user._id;
      delete user._id;
      // user.token = user.key;
      delete user.key;
      res.status(200).json(user);
    });

  // Error handling
  router.use(function(err, req, res, next) {
    console.error(err);
    if(err.stack) {
      console.error(err.stack);
    }
    res.status(err.status || 500);
    if(err.stack && env !== 'development') {
      delete err.stack;
    }
    res.json(err);
  });

};
