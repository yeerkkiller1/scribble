var ws = require("nodejs-websocket")
var http = require('http')
var fs = require('fs')
var misc = require('./misc')

var app = http.createServer(handler)
var port = Number(process.env.PORT || 8000);
app.listen(port, function() {
  console.log("Ready at http://localhost:" + port + "/index.html");
});

function handler(req, res) {
    fs.readFile(__dirname + req['url'], function(err, data) {
        if (err) {
            res.writeHead(404);
            res.end("File not found!");
            return;
        }
        res.writeHead(200);
        res.end(data);
    });
}
 
Array.prototype.random = function () {
  return this[Math.floor((Math.random()*this.length))];
}

function throttle(fn, threshhold) {
  var last = 0;
  return function () {
    var now = Date.now();
    if (now < last + (threshhold || 500)) return;
    last = now;
    return fn.apply(null, arguments);
  };
}

var words = (() => {
    var lines = fs.readFileSync("words.csv").toString().split("\n");
    var header = lines[0].split(',');
    return lines.slice(1).map(l => l.split(',')).map(vals => {
        var obj = {};
        for (var i = 0; i < vals.length; i++) {
            obj[header[i]] = vals[i];
        }
        return obj;
    });
})()

function randomWord() {
    var word = words.random();
    return {
        hint: () => stripAccents(word.english).replace(/[a-zA-Z.]/g, "_"),
        drawer: () => word.english,
        match: (guess) => matchAnyLanguage(word, guess),
        word: word,
    };
    //var lang = Object.keys(word).filter(
    return "många";
    return 'apple'; // for testing
    // TODO: could be a larger word list. Other languages.
    return ["apple", "pepper", "chicken", "potato", "neuken", "keuken", "många"].random();
}
var stripAccents = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "");
function matchAnyLanguage(word, guess) {
    for (var lan in word) {
        if (word[lan].length < 1) continue; // Skip the empty words.
        if (stripAccents(guess) === stripAccents(word[lan])) return true;
    }
    return false;
}

// For now, only one game. Easy to change.

var host_player_id = -1;

var STATE_LOBBY = 'lobby', STATE_GAME = 'game';
var game_state = STATE_LOBBY;
var next_player_id = 10;
var players = {};

var coalesce = (() => {
    var prevID = 0;
    var numRecv = 0;
    var numSent = 0;
    var numBroad = 0;
    var different = (a, b) => a !== b && a !== -b && a !== 0 && b !== 0;
    return (id, msg) => {
        var typ = misc.split(msg, ',', 2)[0];
        if ((numRecv + numSent + numBroad) > 0 && (typ !== 'd' || different(id, prevID))) {
            if (numRecv > 0) console.log("Received", numRecv, "draw messages from", prevID)
            if (numSent > 0) console.log("Sent", numSent, "draw messages to player", prevID);
            if (numBroad > 0) console.log("Broadcast", numBroad, "draw messages to players", Object.keys(players));
            numRecv = numSent = numBroad = 0;
            return false;
        }
        if (typ !== 'd') return false;
        if (id !== 0) prevID = Math.abs(id);
        if (id < 0) numRecv++;
        else if (id > 0) numSent++;
        else if (id === 0) numBroad++;
        return true;
    };
})();

var num_players = (state, cond) => {
    var state_filt = (id) => players[id].state === state;
    if (!state) state_filt = (id) => true;
    var cond_filt = cond && (id => cond(players[id])) || () => true;
    return Object.keys(players).filter(state_filt).filter(cond_filt).length;
}

var broadcast = (msg) => {
    if (!coalesce(0, msg)) console.log("Broadcasting", msg, "to players", Object.keys(players));
    for (var id in players) { players[id].conn.sendText(msg) }};

var send = (id, msg) => {
    if (!coalesce(id, msg)) console.log("Sending", msg, "to player", id);
    players[id].conn.sendText(msg);}

var next_id = (prev_id, state) => {
    var ids = Object.keys(players).map(s => parseInt(s));
    var fids = ids;
    if (state !== undefined) {
        fids = ids.filter(id => players[id].state === state);
    }
    if (ids.length === 0 || fids.length === 0) return -1;
    if (fids.length === 1) return fids[0];
    var id = prev_id;
    while (true) {
        id++;
        if (id > next_player_id) id = 0;
        if (fids.indexOf(id) >= 0) return id;
        if (id === prev_id) {
            console.log("WARNING, WE COULDNT FIND A NEXT ID (should never happen)");
            return prev_id;
        }
    }
}

var drawing, drawing_player_id, current_word, current_hint;
var drawing_and_word_reset = () => {
    drawing = [];
    drawing_player_id = next_id(drawing_player_id, STATE_GAME);
    current_word = randomWord();
    current_hint = current_word.hint();
    for (var id in players) players[id].voting_to_skip = false;
};
drawing_and_word_reset();

var tell_clients_about_new_drawing = () => {
    broadcast("e");
    send(drawing_player_id, 'w,draw,' + current_word.drawer());
    tell_clients_about_new_hint();
    broadcast('g,drawer,' + drawing_player_id);
};

var compute_next_hint = () => {
    var tmp = current_hint.split('');
    var blankIndex = tmp.map((c, i) => [c, i]).filter(a => a[0] === '_').map(a => a[1]).random();
    tmp[blankIndex] = current_word.drawer()[blankIndex];
    current_hint = tmp.join(''); // Strings are immutable, have to do a funny dance.
};

var tell_clients_about_new_hint = () => {
    for (var id in players) {
        players[id].voting_for_hint = false;
        if (id == drawing_player_id) continue;
        send(id, 'w,guess,' + current_hint);
    }
};

var server = ws.createServer(function (conn) {
    // Flow:
    //  Load page -> lobby. Join with default name, assigned ID.
    //  While in lobby, can change name and face.
    //  Game starts, lobby hidden, replaced with draw surface.
    // Protocol: Comma seperated, defined order. First item is message type.
    //  l,543
    // Responds with your ID
    //  g,host,543
    // The game host is player id 543
    //  s
    // Game is started / start game
    //  p,name,Trump
    // Set your player properties, here name to trump. Only valid in lobby.
    //  p,543,name,Trump
    // Signifies a player with id 543 has changed name to Trump. May be new
    // or existing player.
    //  q,543
    // Player id 543 has quit
    //  c,543,A message
    // Is a chat message / guess
    //  w,draw,chicken
    // Is a word for the drawer to draw
    //  d,257,356
    // Is a mouse move / draw command
    //  t,brush
    // Changes the tool that is used in draw commands.
    //  e
    // Empties the canvas, clears all draw queues. Used when switching drawers.
    console.log("New connection");
    var print_not_your_turn = throttle(() => send(my_id, "c,0,Not your turn to draw, or game not started!"));

    var my_id = next_player_id++;
    players[my_id] = {
        conn: conn,
        name: "Anon " + ~~(Math.random()*1000),
        state: STATE_LOBBY,
        score: 0,
    };
    send(my_id, 'l,' + my_id);
    for (var id in players) {
        if (parseInt(id) === my_id) continue;
        send(my_id, 'p,' + id + ',name,' + players[id].name);
        send(my_id, 'p,' + id + ',state,' + players[id].state);
    }
    broadcast('p,' + my_id + ',name,' + players[my_id].name);
    broadcast('p,' + my_id + ',state,' + players[my_id].state);
    if (host_player_id < 0) host_player_id = my_id;
    send(my_id, 'g,host,' + host_player_id);
    if (game_state == STATE_GAME) {
        send(my_id, 's');
        drawing.forEach(msg => send(my_id, msg));
    }
    conn.on("text", function (str) {
        if (!coalesce(-my_id, str)) console.log("Received "+str)
        var tmp = misc.split(str, ',', 2), typ = tmp[0], msg = tmp[1];
        switch (typ) {
        case 'p':
            if (players[my_id].state != STATE_LOBBY) {
                send(my_id, 'c,0,Cannot change player properties in game.');
                return;
            }
            var tmp = misc.split(msg, ',', 2), prop = tmp[0], val = tmp[1];
            if (prop === 'name') {
                if (val.length > 20) {
                    send(my_id, 'c,0,Username too long, max 20 characters.');
                    return;
                }
                players[my_id].name = val;
            }
            else console.log(">>>ERR UNKNOWN PROP", my_id, prop, val);
            broadcast('p,' + my_id + ',' + prop + ',' + val);
            break;
        case 's':
            if (players[my_id].state != STATE_LOBBY) {
                send(my_id, "c,0,Cannot join if not in lobby.")
                return;
            }
            if ((game_state !== STATE_GAME) && (my_id !== host_player_id)) {
                send(my_id, "c,0,You are not the host, cannot start game.");
                return;
            }
            if (my_id === host_player_id) {
                game_state = STATE_GAME;
                drawing_and_word_reset();
                broadcast('s');
            }
            if (drawing_player_id < 0) {
                drawing_player_id = my_id;
                send(my_id, 'w,draw,' + current_word.drawer());
            } else {
                send(my_id, 'w,hint,' + current_hint);
            }
            send(my_id, 'g,drawer,' + drawing_player_id);

            players[my_id].state = STATE_GAME;
            broadcast('p,' + my_id + ',state,' + players[my_id].state);
            broadcast('c,0,' + players[my_id].name + ' has joined!');
            break;
        case 'c':
            var guess = msg;
            if (guess.length > 100) {
                send(my_id, 'c,0,Chat message too long!');
                return;
            }
            if (guess.trim().length === 0) {
                send(my_id, 'c,0,Chat message is entirely whitespace!');
                return;
            }
            if (guess.trim() === "/skip") {
                if (players[my_id].state !== STATE_GAME) {
                    send(my_id, 'c,0,Cannot vote to skip if not in game!');
                    return;
                }
                if (players[my_id].voting_to_skip) {
                    send(my_id, 'c,0,Already voted to skip!');
                    return;
                }
                players[my_id].voting_to_skip = true;
                var num_votes = num_players(STATE_GAME, p => p.voting_to_skip);
                var votes_needed = Math.floor(2*num_players(STATE_GAME)/3.);
                broadcast("c,0," + my_id + " voted to skip, " + num_votes + " / " + votes_needed);
                if (num_votes >= votes_needed) {
                    broadcast("c,0,Player " + drawing_player_id + " (name " + players[drawing_player_id].name + ") was skipped!");
                    broadcast("c,0,The word was " + current_word.drawer());
                    drawing_and_word_reset();
                    tell_clients_about_new_drawing();
                }
                return;
            }
            if (guess.trim() === "/hint") {
                if (players[my_id].state !== STATE_GAME) {
                    send(my_id, 'c,0,Cannot vote for hints if not in game!');
                    return;
                }
                if (players[my_id].voting_for_hint) {
                    send(my_id, 'c,0,Already voted for hint');
                    return;
                }
                players[my_id].voting_for_hint = true;
                var num_votes = num_players(STATE_GAME, p => p.voting_for_hint);
                var votes_needed = Math.ceil(num_players(STATE_GAME)/2.);
                broadcast("c,0," + my_id + " voted for a hint, " + num_votes + " / " + votes_needed);
                if (num_votes >= votes_needed) {
                    compute_next_hint();
                    tell_clients_about_new_hint();
                }
                return;
            }
            if ((game_state === STATE_GAME) && (my_id !== drawing_player_id) &&
                    current_word.match(guess)) {
                broadcast("c,0,Player " + my_id + " (name " + players[my_id].name + ") wins!");
                broadcast("c,0,The word was " + guess + " (or " + current_word.drawer() + ")");
                drawing_and_word_reset();
                tell_clients_about_new_drawing();
                return;
            }
            broadcast('c,' + my_id + ',' + guess);
            break;
        case 'd':
            if (my_id != drawing_player_id || game_state !== STATE_GAME) {
                print_not_your_turn();
                return;
            }
            drawing.push(str);
            broadcast(str);
            break;
        default: broadcast('c,0,Unhandled message "' + str + '", ignoring.'); break;
        }
    })
    conn.on("close", function (code, reason) {
        console.log("Connection closed")
        var name = players[my_id].name;
        delete players[my_id];
        broadcast('q,' + my_id);
        broadcast('c,0,Player ' + name + ' with id ' + my_id + ' has quit!');
        if (my_id === host_player_id) {
            host_player_id = next_id(host_player_id);
            broadcast('g,host,' + host_player_id);
        }
        if (my_id === drawing_player_id) {
            broadcast('c,0,The drawer left!');
            drawing_and_word_reset();
            // If a tree falls in a forest... It throws an exception
            if (drawing_player_id >= 0) tell_clients_about_new_drawing();
        }
    })
    conn.on("error", function (err) {
        console.log("Error (probably doesn't matter):", err);
    });
}).listen(8001)