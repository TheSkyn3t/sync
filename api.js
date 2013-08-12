/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var Auth = require("./auth");
var Logger = require("./logger");
var ActionLog = require("./actionlog");
var fs = require("fs");


module.exports = function (Server) {
    function getIP(req) {
        var raw = req.connection.remoteAddress;
        var forward = req.header("x-forwarded-for");
        if(Server.cfg["trust-x-forward"] && forward) {
            var ip = forward.split(",")[0];
            Logger.syslog.log("REVPROXY " + raw + " => " + ip);
            return ip;
        }
        return raw;
    }

    function getChannelData(channel) {
        var data = {
            name: channel.name,
            loaded: true
        };

        data.pagetitle = channel.opts.pagetitle;
        data.media = channel.playlist.current ?
                     channel.playlist.current.media.pack() :
                     {};
        data.usercount = channel.users.length;
        data.afkcount = channel.afkers.length;
        data.users = [];
        for(var i in channel.users)
            if(channel.users[i].name !== "")
                data.users.push(channel.users[i].name);

        data.chat = [];
        for(var i in channel.chatbuffer)
            data.chat.push(channel.chatbuffer[i]);

        return data;
    }

    var app = Server.app;

    /* <https://en.wikipedia.org/wiki/Hyper_Text_Coffee_Pot_Control_Protocol> */
    app.get("/api/coffee", function (req, res) {
        res.send(418); // 418 I'm a teapot
    });

    /* REGION channels */
    
    /* data about a specific channel */
    app.get("/api/channels/:channel", function (req, res) {
        var name = req.params.channel;
        if(!name.match(/^[\w-_]+$/)) {
            res.send(404);
            return;
        }
        
        var data = {
            name: name,
            loaded: false
        };

        if(Server.channelLoaded(name))
            data = getChannelData(Server.getChannel(name));

        res.type("application/json");
        res.jsonp(data);
    });

    /* data about all channels (filter= public or all) */
    app.get("/api/allchannels/:filter", function (req, res) {
        var filter = req.params.filter;
        if(filter !== "public" && filter !== "all") {
            res.send(400);
            return;
        }

        var query = req.query;

        // Listing non-public channels requires authenticating as an admin
        if(filter !== "public") {
            var name = query.name || "";
            var session = query.session || "";
            var row = Auth.login(name, "", session);
            if(!row || row.global_rank < 255) {
                res.send(403);
                return;
            }
        }
        
        var channels = [];
        for(var key in Server.channels) {
            var channel = Server.channels[key];
            if(channel.opts.show_public) {
                channels.push(getChannelData(channel));
            } else if(filter !== "public") {
                channels.push(getChannelData(channel));
            }
        }

        res.type("application/jsonp");
        res.jsonp(channels);
    });

    /* ENDREGION channels */

    /* REGION authentication, account management */

    /* login */
    app.post("/api/login", function (req, res) {
        res.type("application/jsonp");
        var name = req.body.name;
        var pw = req.body.pw;
        var session = req.body.session;

        // for some reason CyTube previously allowed guest logins
        // over the API...wat
        if(!pw && !session) {
            res.jsonp({
                success: false,
                error: "You must provide a password"
            });
            return;
        }

        var row = Auth.login(name, pw, session);
        if(!row) {
            if(session && !pw) {
                res.jsonp({
                    success: false,
                    error: "Session expired"
                });
                return;
            } else {
                ActionLog.record(getIP(req), name, "login-failure",
                                 "invalid_password");
                res.jsonp({
                    success: false,
                    error: "Provided username/password pair is invalid"
                });
                return;
            }
        }

        // record the login if the user is an administrator
        if(row.global_rank >= 255)
            ActionLog.record(getIP(req), name, "login-success");
            
        res.jsonp({
            success: true,
            name: name,
            session: row.session_hash
        });
    });

    /* register an account */
    app.post("/api/register", function (req, res) {
        res.type("application/jsonp");
        var name = req.body.name;
        var pw = req.body.pw;
        var ip = getIP(req);

        // Limit registrations per IP within a certain time period
        if(ActionLog.tooManyRegistrations(ip)) {
            ActionLog.record(ip, name, "register-failure",
                "Too many recent registrations");
            res.jsonp({
                success: false,
                error: "Your IP address has registered too many accounts "+
                       "in the past 48 hours.  Please wait a while before"+
                       " registering another."
            });
            return;
        }

        if(!pw) {
            // costanza.jpg
            res.jsonp({
                success: false,
                error: "You must provide a password"
            });
            return;
        }

        if(!Auth.validateName(name)) {
            ActionLog.record(ip, name, "register-failure", "Invalid name");
            res.jsonp({
                success: false,
                error: "Invalid username.  Valid usernames must be 1-20 "+
                       "characters long and consist only of alphanumeric "+
                       "characters and underscores (_)"
            });
            return;
        }

        if(Auth.isRegistered(name)) {
            ActionLog.record(ip, name, "register-failure", "Name taken");
            res.jsonp({
                success: false,
                error: "That username is already taken"
            });
            return;
        }

        var session = Auth.register(name, pw);
        if(!session) {
            res.jsonp({
                success: false,
                error: "Registration error.  Contact an administrator "+
                       "for assistance."
            });
            return;
        }

        ActionLog.record(ip, name, "register-success");
        res.jsonp({
            success: true,
            session: session
        });
    });

    /* password change */
    app.post("/api/account/passwordchange", function (req, res) {
        res.type("application/jsonp");

        var name = req.body.name;
        var oldpw = req.body.oldpw;
        var newpw = req.body.newpw;

        if(!oldpw || !newpw) {
            res.jsonp({
                success: false,
                error: "Password cannot be empty"
            });
            return;
        }

        var row = Auth.login(name, oldpw, "");
        if(!row) {
            res.jsonp({
                success: false,
                error: "Invalid username/password combination"
            });
            return;
        }

        ActionLog.record(getIP(req), name, "password-change");
        var success = Auth.setUserPassword(name, newpw);
        
        if(!success) {
            res.jsonp({
                success: false,
                error: "Server error.  Please try again or ask an "+
                       "administrator for assistance."
            });
            return;
        }

        res.jsonp({
            success: true,
            session: row.session_hash
        });
    });

    /* password reset */
    app.post("/api/account/passwordreset", function (req, res) {
        res.type("application/jsonp");
        var name = req.body.name;
        var email = req.body.email;
        var ip = getIP(req);
        var hash = false;

        try {
            hash = Server.db.generatePasswordReset(ip, name, email);
            ActionLog.record(ip, name, "password-reset-generate", email);
        } catch(e) {
            res.jsonp({
                success: false,
                error: e
            });
            return;
        }

        if(!Server.cfg["enable-mail"]) {
            res.jsonp({
                success: false,
                error: "This server does not have email recovery enabled."+
                       "  Contact an administrator for assistance."
            });
            return;
        }

        if(!email) {
            res.jsonp({
                success: false,
                error: "You don't have a recovery email address set.  "+
                       "Contact an administrator for assistance."
            });
            return;
        }

        var msg = "A password reset request was issued for your account '"+
                  name + "' on " + Server.cfg["domain"] + ".  This request"+
                  " is valid for 24 hours.  If you did not initiate this, "+
                  "there is no need to take action.  To reset your "+
                  "password, copy and paste the following link into your "+
                  "browser: " + Server.cfg["domain"] + "/reset.html?"+hash;

        var mail = {
            from: "CyTube Services <" + Server.cfg["mail-from"] + ">",
            to: emial,
            subject: "Password reset request",
            text: msg
        };

        Server.cfg["nodemailer"].sendMail(mai, function (err, response) {
            if(err) {
                Logger.errlog.log("mail fail: " + err);
                res.jsonp({
                    success: false,
                    error: "Email send failed.  Contact an administrator "+
                           "if this persists"
                });
            } else {
                res.jsonp({
                    success: true
                });
            }
        });
    });

    /* password recovery */
    app.get("/api/account/passwordrecover", function (req, res) {
        res.type("application/jsonp");
        var hash = req.query.hash;
        var ip = getIP(req);

        try {
            var info = Server.db.recoverPassword(hash);
            res.jsonp({
                success: true,
                name: info[0],
                pw: info[1]
            });
            ActionLog.record(ip, info[0], "password-recover-success");
        } catch(e) {
            ActionLog.record(ip, "", "password-recover-failure", hash);
            res.jsonp({
                success: false,
                error: e
            });
        }
    });

    /* profile retrieval */
    app.get("/api/users/:user/profile", function (req, res) {
        res.type("application/jsonp");
        var name = req.params.user;

        try {
            var prof = Server.db.getProfile(name);
            res.jsonp({
                success: true,
                profile_image: prof.profile_image,
                profile_text: prof.profile_text
            });
        } catch(e) {
            res.jsonp({
                success: false,
                error: e
            });
        }
    });

    /* profile change */
    app.post("/api/account/profile", function (req, res) {
        res.type("application/jsonp");
        var name = req.body.name;
        var pw = req.body.pw;
        var session = req.body.session;
        var img = req.body.profile_image;
        var text = req.body.profile_text;

        var row = Auth.login(name, pw, session);
        if(!row) {
            res.jsonp({
                success: false,
                error: "Invalid login"
            });
            return;
        }

        var result = Server.db.setProfile(name, {
            image: img,
            text: text
        });

        if(!result) {
            res.jsonp({
                success: false,
                error: "Server error.  Contact an administrator for assistance"
            });
            return;
        }

        res.jsonp({
            success: true
        });

        // Update profile on all channels the user is connected to
        name = name.toLowerCase();
        for(var i in Server.channels) {
            var chan = Server.channels[i];
            for(var j in chan.users) {
                var user = chan.users[j];
                if(user.name.toLowerCase() == name) {
                    user.profile = {
                        image: img,
                        text: text
                    };
                    chan.broadcastUserUpdate(user);
                }
            }
        }

    });

    /* set email */
    app.post("/api/account/email", function (req, res) {
        res.type("application/jsonp");
        var name = req.body.name;
        var pw = req.body.pw;
        var email = req.body.email;

        if(!email.match(/^[\w_\.]+@[\w_\.]+[a-z]+$/i)) {
            res.jsonp({
                success: false,
                error: "Invalid email address"
            });
            return;
        }

        if(email.match(/.*@(localhost|127\.0\.0\.1)/i)) {
            res.jsonp({
                success: false,
                error: "Nice try, but no"
            });
            return;
        }

        var row = Auth.login(name, pw, "");
        if(!row) {
            res.jsonp({
                success: false,
                error: "Invalid login credentials"
            });
            return;
        }

        var success = Server.db.setUserEmail(name, email);
        if(!success) {
            res.jsonp({
                success: false,
                error: "Email update failed.  Contact an administrator "+
                       "for assistance."
            });
            return false;
        }

        ActionLog.record(getIP(req), name, "email-update", email);
        res.jsonp({
            success: true,
            session: row.session_hash
        });
    });

    /* my channels */
    app.get("/api/account/mychannels", function (req, res) {
        res.type("application/jsonp");
        var name = req.query.name;
        var session = req.query.session;

        var row = Auth.login(name, "", session);
        if(!row) {
            res.jsonp({
                success: false,
                error: "Invalid login"
            });
            return;
        }

        var channels = Server.db.listUserChannels(name);
        res.jsonp({
            success: true,
            channels: channels
        });
    });

    /* END REGION */

    /* REGION log reading */

    /* action log */
    app.get("/api/logging/actionlog", function (req, res) {
        res.type("application/jsonp");
        var name = req.query.name;
        var session = req.query.session;
        var types = req.query.actions;

        var row = Auth.login(name, "", session);
        if(!row || row.global_rank < 255) {
            res.send(403);
            return;
        }

        types = types.split(",");
        var actions = ActionLog.readLog(types);
        res.jsonp(actions);
    });

    /* helper function to pipe the last N bytes of a file */
    function pipeLast(res, file, len) {
        fs.stat(file, function (err, data) {
            if(err) {
                res.send(500);
                return;
            }
            var start = data.size - len;
            if(start < 0) {
                start = 0;
            }
            var end = data.size - 1;
            fs.createReadStream(file, { start: start, end: end })
                .pipe(res);
        });
    }

    app.get("/api/logging/syslog", function (req, res) {
        res.type("text/plain");
        res.setHeader("Access-Control-Allow-Origin", "*");

        var name = req.query.name;
        var session = req.query.session;

        var row = Auth.login(name, "", session);
        if(!row || row.global_rank < 255) {
            res.send(403);
            return;
        }

        pipeLast(res, "sys.log", 1048576);
    });

    app.get("/api/logging/errorlog", function (req, res) {
        res.type("text/plain");
        res.setHeader("Access-Control-Allow-Origin", "*");

        var name = req.query.name;
        var session = req.query.session;

        var row = Auth.login(name, "", session);
        if(!row || row.global_rank < 255) {
            res.send(403);
            return;
        }

        pipeLast(res, "error.log", 1048576);
    });

    app.get("/api/logging/channels/:channel", function (req, res) {
        res.type("text/plain");
        res.setHeader("Access-Control-Allow-Origin", "*");

        var name = req.query.name;
        var session = req.query.session;

        var row = Auth.login(name, "", session);
        if(!row || row.global_rank < 255) {
            res.send(403);
            return;
        }

        var chan = req.params.channel || "";
        if(!chan.match(/^[\w-_]+$/)) {
            res.send(400);
            return;
        }

        fs.exists("chanlogs/" + chan + ".log", function(exists) {
            if(exists) {
                pipeLast(res, "chanlogs/" + chan + ".log", 1048576);
            } else {
                res.send(404);
            }
        });
    });

    return null;
}
