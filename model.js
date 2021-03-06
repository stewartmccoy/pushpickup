// Meteor.Collection declarations are in lib/collections.js

DateRange = Match.Where(function (x) {
  check(x, {gte: Date, lt: Date});
  return (x.gte < x.lt);
});

Day = Match.Where(function (d) {
  return _.contains([0,1,2,3,4,5,6], d);
});

Longitude = Match.Where(function (x) {
  check(x, Number);
  return x >= -180 && x <= 180;
});

Latitude = Match.Where(function (x) {
  check(x, Number);
  return x >= -90 && x <= 90;
});

GeoJSONPolygon = Match.Where(function (x) {
  check(x, {type: String, coordinates: [[[Number]]]});
  return (x.type === "Polygon") &&
    (x.coordinates.length === 1) &&
    _.every(x.coordinates[0], function (coord) {
      check(coord[0], Longitude);
      check(coord[1], Latitude);
      return coord.length === 2;
    });
});

GeoJSONPoint = Match.Where(function (x) {
  check(x, {type: String, coordinates: [Number]});
  check(x.coordinates[0], Longitude);
  check(x.coordinates[1], Latitude);
  return (x.type === "Point") && (x.coordinates.length === 2);
});

GameType = Match.Where(function (x) {
  check(x, String);
  var types = _.pluck(GameOptions.find({option: "type"}).fetch(),
                      'value');
  return _.contains(types, x);
});

GameStatus = Match.Where(function (x) {
  check(x, String);
  var statuses = _.pluck(GameOptions.find({option: "status"}).fetch(),
                         'value');
  return _.contains(statuses, x);
});

WithinAWeekFromNow = Match.Where(function (x) {
  check(x, Date);
  var then = moment(x);
  var now = moment();
  var aWeekFromNow = moment().add('weeks', 1);
  return now.isBefore(then) && then.isBefore(aWeekFromNow);
});

NonEmptyString = Match.Where(function (x) {
  check(x, String);
  if (x.length === 0)
    throw new Match.Error("Cannot be blank.");
  return true;
});

NonNegativeInteger = Match.Where(function (x) {
  check(x, Match.Integer);
  return x >= 0;
});

var rsvps = ["in"];
Player = Match.Where(function (x) {
  check(x, Match.ObjectIncluding({
    userId: Match.Optional(String),
    name: NonEmptyString,
    rsvp: String}));
  return _.contains(rsvps, x.rsvp);
});

ValidEmail = Match.Where(function (x) {
  // Uses RegExp of http://www.w3.org/TR/html-markup/input.email.html
  return /^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(x);
});

ValidPassword =  Match.Where(function (x) {
  check(x, NonEmptyString);
  if (x.length < 6)
    throw new Match.Error("Password must be at least 6 characters.");
  return true;
});

ValidGame = {
  //createdBy: Match.Optional(String), <-- not passed in
  //notificationsSent: Match.Optional(Boolean)
  type: GameType,
  status: GameStatus,
  startsAt: WithinAWeekFromNow,
  location: {name: NonEmptyString,
             geoJSON: GeoJSONPoint},
  note: String,
  players: [Player],
  requested: Match.ObjectIncluding({players: NonNegativeInteger})
};

maybeMakeGameOn = function (gameId) {
  var game = Games.findOne(gameId);
  if (game.status === "proposed" &&
      (game.players.length >= game.requested.players)) {
    Games.update(gameId, {$set: {status: "on"}});
  }
};

// Donny can edit all games without ssh access to database
var donny = Meteor.users.findOne({
  'emails.address': 'donny@pushpickup.com'
});
var donnyId = donny && donny._id;

Meteor.methods({
  getDonnyId: function () { return donnyId; },
  // assumes this.userId is not null
  // see unauthenticated.addGame for when this.userId is null
  addGame: function (game) {
    var self = this;
    var user = Meteor.user();
    check(game, ValidGame);

    if (game.location.name.length > 100)
      throw new Meteor.Error(413, "Location name too long");
    if (game.note.length > 1000)
      throw new Meteor.Error(413, "Game note too long");

    game = _.extend(game, {createdBy: user._id});
    return {gameId: Games.insert(game)};
  },
  editGame: function (id, game) {
    var self = this;
    check(game, ValidGame);
    var oldGame = Games.findOne(id);
    var isCreator = Match.test(oldGame.createdBy, Match.Where(function (id) {
      return id === self.userId;
    }));

    if (! isCreator) {
      if (Meteor.isServer) {
        check(self.userId, Match.Where(function (id) {
          return (id === donnyId);
        }));
      }
    }

    if (game.location.name.length > 100)
      throw new Meteor.Error(413, "Location name too long");
    if (game.note.length > 1000)
      throw new Meteor.Error(413, "Game note too long");

    return Games.update(id, {$set: {
      type: game.type,
      status: game.status,
      startsAt: game.startsAt,
      location: game.location,
      note: game.note,
      players: game.players,
      requested: game.requested
    }});
  },
  cancelGame: function (id) {
    var self = this;
    var game = Games.findOne(id);
    check(game.createdBy, Match.Where(function (id) {
      return id === self.userId;
    }));
    if (Meteor.isServer) {
      this.unblock();
      var email;
      _.each(game.players, function (player) {
        if (player.userId) {
          email = Meteor.users.findOne(player.userId).emails[0];
          if (email.verified) {
            Email.send({
              from: "support@pushpickup.com",
              to: player.name + "<" + email.address + ">",
              subject: "Game CANCELLED: " + game.type + " " +
                moment(game.startsAt).format('dddd h:mmA') + " at " +
                game.location.name,
              text: "Sorry, " + player.name + ".\n" +
                "This game has been cancelled by the organizer. Check out " +
                Meteor.absoluteUrl('') + " for other games, or " +
                "announce/propose your own!"
            });
          }
        }
      });
    }
    return Games.remove(id);
  },
  // this.userId is not null
  // for unauthenticated adds, see "unauthenticated.addPlayer"
  addPlayer: function (gameId, name) {
    var player = {userId: this.userId, name: name, rsvp: "in"};
    check(player, Player); // name must be non-empty
    Games.update(gameId, {$push: {players: player}});
    maybeMakeGameOn(gameId);
    return true;
  },
  editGamePlayer: function (gameId, fields) {
    var self = this;
    check(fields, {oldName: NonEmptyString, newName: NonEmptyString});
    // Minimongo doesn't support use of the `$` field yet.
    // Consider having a separate Players collection.
    if (Meteor.isServer) {
      Games.update({
        _id: gameId,
        "players.userId": self.userId,
        "players.name": fields.oldName
      }, {$set: {"players.$.name": fields.newName}});
    }

    // email taken -> error
    // if (Meteor.users.findOne({'emails.address': email})) {
    //   throw new Meteor.Error(401, "Email already belongs to user");
    // }
  },
  pullPlayer: function (name, gameId) {
    var self = this;
    // If user added two players with same name, both are removed.
    // Note: client UI alerts if name to add is already taken.
    Games.update(gameId, {$pull: {players: {userId: self.userId, name: name}}});
  }
});

recordsPerPage = 10;
