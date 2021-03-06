var moment = require('moment');

module.exports = function (params) {

    // Params
    var server = params.server;
    var io = params.socket;

    // Internal dependencies
    var Activity = require('./Schema');
    var User = require('../User/Schema');
    var Session = require('../Socket/Schema');
    var Authentication = require('../Authentication')(params);

    server.get('/api/activities',
        Authentication.ensureAuthenticated,
        Authentication.ensureIsAdmin,
        function (req, res, next) {
            Activity.find({}).sort('-datetime').populate('creator members', '-friends -facebookToken -facebookId -email').exec(function (err, result) {
                res.json(result);
            });
        });

    server.get('/api/activities/wall',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            User.findById(req.user, function (err, user) {
                if (!user) {
                    return res.status(400).send({message: 'User not found'});
                } else {
                    // From
                    var from = moment(new Date());
                    from.subtract(7, 'days');
                    // To
                    var to = moment(new Date());
                    to.add(7, 'days');
                    // Me
                    user.friends.push(req.user);
                    // Query
                    Activity.find({
                        members: {$in: user.friends},
                        datetime: {$gte: from.toDate(), $lte: to.toDate()}
                    }).sort('-datetime').populate('creator members', '-friends -facebookToken -facebookId -email').exec(function (err, result) {
                        res.json(result);
                    });
                }
            });
        });

    server.get('/api/activities/me',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            Activity.find({members: req.user}).sort('-datetime').populate('creator members', '-friends -facebookToken -facebookId -email').exec(function (err, result) {
                res.json(result);
            });
        });

    server.get('/api/activities/:id',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            User.findOne({_id: req.user, friends: req.params.id}, function (err, user) {
                if (!user) {
                    res.status(500).send({message: 'Invalid Friend'});
                } else {
                    Activity.find({members: req.params.id}).sort('-datetime').populate('creator members', '-friends -facebookToken -facebookId -email').exec(function (err, result) {
                        res.json(result);
                    });
                }
            });
        });

    server.get('/api/activities/me/stats',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            Activity.find({members: req.user}).populate('creator members', '-friends -facebookToken -facebookId -email').exec(function (err, activities) {
                res.json({
                    activities: activities.length,
                    teams: activities.reduce(function (a, b) {
                        return a + (b.members.length > 1 ? 1 : 0);
                    }, 0)
                })
            });
        });


    server.get('/api/activity/:id/subscribe',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            Activity.findOneAndUpdate({_id: req.params.id}, {$addToSet: {members: req.user}}, {new: true}, function (err, activity) {
                if (activity) {
                    activity.populate('creator members', '-friends -facebookToken -facebookId -email', function (err, activity) {
                        broadcastActivity('update', activity, req.user);
                        res.json(activity)
                    });
                } else {
                    res.status(500).send({message: 'Invalid Activity'});
                }
            });
        });

    server.get('/api/activity/:id/unsubscribe',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            Activity.findOne({_id: req.params.id, members: req.user}).exec(function (err, activity) {
                if (activity) {
                    activity.members.pull(req.user);
                    activity.save(function (err, activity) {
                        if (activity) {
                            activity.populate('creator members', '-friends -facebookToken -facebookId -email', function (err, activity) {
                                broadcastActivity('update', activity, req.user);
                                res.json(activity)
                            });
                        } else {
                            res.status(500).send({message: 'Invalid Activity'});
                        }
                    })
                } else {
                    res.status(500).send({message: 'Invalid Activity'});
                }
            });
        });

    server.post('/api/activity',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            var data = req.body;
            data.creator = req.user;
            var activity = new Activity(data);
            activity.members = [req.user];
            activity.save(function (err, activity) {
                if (activity) {
                    activity.populate('creator members', '-friends -facebookToken -facebookId -email', function (err, activity) {
                        broadcastActivity('create', activity, req.user);
                        res.json(activity)
                    });
                } else {
                    res.status(500).send({message: 'Invalid Activity'});
                }
            });
        });

    server.post('/api/activity/:user',
        Authentication.ensureAuthenticated,
        Authentication.ensureIsAdmin,
        function (req, res, next) {
            var data = req.body;
            data.creator = req.params.user;
            var activity = new Activity(data);
            activity.members = [req.params.user];
            activity.save(function (err, activity) {
                if (activity) {
                    activity.populate('creator members', '-friends -facebookToken -facebookId -email', function (err, activity) {
                        broadcastActivity('create', activity, req.params.user);
                        res.json(activity)
                    });
                } else {
                    res.status(500).send({message: 'Invalid Activity'});
                }
            });
        });

    server.put('/api/activity/:id',
        Authentication.ensureAuthenticated,
        function (req, res, next) {
            var data = req.body;
            Activity.findOneAndUpdate({
                _id: req.params.id,
                creator: req.user
            }, data, {new: true}, function (err, activity) {
                if (activity) {
                    activity.populate('creator members', '-friends -facebookToken -facebookId -email', function (err, activity) {
                        broadcastActivity('update', activity, req.user);
                        res.json(activity)
                    });
                } else {
                    res.status(500).send({message: 'Invalid Activity'});
                }
            });
        });

    server.delete('/api/activity/:activity',
        Authentication.ensureAuthenticated,
        Authentication.ensureIsAdmin,
        function (req, res, next) {
            Activity.findOne({_id: req.params.activity}, function (err, activity) {
                if (!activity) {
                    res.status(500).send({message: 'Invalid Activity'});
                } else {
                    broadcastActivity('delete', activity, req.user);
                    Activity.remove({_id: req.params.activity}, function (err, response) {
                        res.json(response)
                    });
                }
            });
        });

    function broadcastActivity(operation, activity, user_id) {
        switch (operation) {
            case 'update':
                Session.find({$or: [{user: {$in: activity.members}}, {user: user_id}]}, function (err, sessions) {
                    sessions.forEach(function (session) {
                        io.to(session.socket).emit('activity:' + operation, activity);
                    });
                });
                break;
            case 'create':
                User.findById(user_id, function (err, user) {
                    Session.find({$or: [{user: {$in: user.friends}}, {user: user_id}]}, function (err, sessions) {
                        sessions.forEach(function (session) {
                            io.to(session.socket).emit('activity:' + operation, activity);
                        });
                    });
                });
                break;
            case 'delete':
                Session.find({$or: [{user: {$in: activity.members}}, {user: user_id}]}, function (err, sessions) {
                    sessions.forEach(function (session) {
                        io.to(session.socket).emit('delete:' + operation, activity);
                    });
                });
                break;
        }


    }

};