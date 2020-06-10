const express = require('express')
const http = require('http')
const socket = require('socket.io')
const sanitize = require('sanitize-html')
const { performance } = require('perf_hooks')
const fs = require('fs')
const port = process.env.PORT || 3000

const app = express()
const server = http.createServer(app)
const io = socket(server)

const Board = require('./board/board.js')

server.listen(port, function () {
    console.log('Server started on *:3000')
    loadBoardData()
})

app.use(express.static('public'))

const MAX_PLAYERS = 8
var boards = {}
var rooms = {}

// Encode the list of players into a format that can be sent through sockets
// This leaves gaps for players that are not currently in the game
function encodeRoomPlayers(players) {
    let output = []
    for (let i = 0; i < MAX_PLAYERS; i++) {
        let player = players[i]
        if (!player) {
            output.push(false)
        } else {
            output.push({ username: player.username })
        }
    }

    return output
}

// Register a new player into a room
function addNewPlayer(roomcode, player, update = true) {
    let room = rooms[roomcode]
    for (let i = 0; i < MAX_PLAYERS; i++) {
        if (!room.players[i]) {
            room.players[i] = player
            if (update) {
                io.to(roomcode).emit('update players', encodeRoomPlayers(room.players))
            }
            return i
        }
    }

    return -1
}

// Remove a player from a room
function removePlayer(roomcode, playerid, update = true) {
    let room = rooms[roomcode]
    room.players[playerid] = false
    if (update) {
        io.to(roomcode).emit('update players', encodeRoomPlayers(room.players))
    }
}

function loadBoardData() {
    boards = {}
    // Search for any files in the board shapes folder
    for (const filename of fs.readdirSync('./board/shapes/')) {
        fs.readFile('./board/shapes/' + filename, (err, content) => {
            if (err) {
                console.error(err)
                return
            } else {
                let boardName = filename.replace('.json', '')
                let board = JSON.parse(content)
                boards[boardName] = board
            }
        })
    }
}

// Generate a new board for a room
function createBoard(boardType = 'Random') {
    let boardName
    if (boardType == 'Random') {
        let boardNames = Object.keys(boards)
        boardName = boardNames[boardNames.length * Math.random() << 0]
    } else {
        boardName = boardType
    }

    let b = new Board()
    b.fromArray(boards[boardName])
    b.shuffleTileTypes()
    return b
}

// Generate a random string of n characters
// This is a recursive function
function randomString(n, base = '') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789'
    let char = letters[Math.floor(Math.random() * letters.length)]

    if (n <= 1) {
        return base + char
    } else {
        return randomString(n - 1, base + char)
    }
}

// Create and register a new room
// This generates a board and random roomcode
function createRoom(boardType = 'Random') {
    // Generate a random room code
    let roomcode = randomString(4)
    if (rooms[roomcode]) {
        roomcode = randomString(4)
    }

    // Create and register the new room
    const room = {
        roomcode: roomcode,
        gamestate: 'lobby',
        players: [],
        board: createBoard(boardType),
        ownerID: 0
    }
    rooms[roomcode] = room

    return roomcode
}

io.on('connection', (socket) => {
    // Send a list of boards on connection
    socket.emit('boards list', Object.keys(boards))


    socket.on('join game', function (roomcode, username) {
        roomcode = roomcode.toUpperCase()
        username = sanitize(username).trim()

        // Ignore logins from people already in rooms
        if (socket.gameRoom) {
            console.log('Discarding login from', username)
            return
        }

        console.log(username, 'trying to join room:', roomcode)

        // Verify that the game room exists
        if (!rooms[roomcode]) {
            socket.emit('login error', 'Room is invalid')
            return
        }
        let room = rooms[roomcode]

        // Don't let people join games that are in progress
        // Might change this later
        if (room.gamestate != 'lobby') {
            socket.emit('login error', 'Room is already in game')
            return
        }

        // Verify that the username is valid
        if (username.length > 20 || username.length < 1) {
            socket.emit('login error', 'Username is invalid')
            return
        }

        // Verify that the username isn't taken
        for (let player of room.players) {
            if (player.username == username) {
                socket.emit('login error', 'Username is already taken')
                return
            }
        }

        // Add the player if there is space
        let player = {
            username: username,
            socket: socket
        }

        let id = addNewPlayer(roomcode, player, false)
        if (id < 0) {
            socket.emit('login error', 'Room is full')
            return
        }
        console.log(username, 'assigned to', id)

        // Player is successfully in the room!
        socket.gameRoom = roomcode
        socket.playerID = id
        socket.join(roomcode)
        console.log(username, 'has joined room:', roomcode)

        socket.emit('joined lobby', roomcode, id)
        socket.emit('create board', room.board)
        io.to(roomcode).emit('update players', encodeRoomPlayers(room.players))
    })

    socket.on('create game', function (username, boardType) {
        // Verify that the username is valid
        if (username.length > 20 || username.length < 1) {
            socket.emit('login error', 'Username is invalid')
            return
        }

        // Create a new room
        const roomcode = createRoom(boardType)
        let room = rooms[roomcode]

        // Add the player to the room
        let player = {
            username: username,
            socket: socket
        }
        let id = addNewPlayer(roomcode, player, false)

        // Player has successfully created a room
        socket.gameRoom = roomcode
        socket.playerID = id
        socket.join(roomcode)
        console.log(username, 'has created room:', roomcode)

        socket.emit('joined lobby', roomcode, id)
        socket.emit('create board', room.board)
        socket.emit('lobby owner')
        io.to(roomcode).emit('update players', encodeRoomPlayers(room.players))
    })

    socket.on('start game', function () {
        if (!socket.gameRoom) return
        let roomcode = socket.gameRoom
        let room = rooms[roomcode]

        if (room.ownerID == socket.playerID) {
            // Start the game
            room.gamestate = 'board'
            io.to(roomcode).emit('start game')

            // Place the foxes on the board
            for (const player of room.players) {
                if (!player) continue
                const id = player.socket.playerID

                const tile = room.board.getRandomEmptyTile()
                room.board.updatePlayer(id, tile.x, tile.y)
            }

            // Network all positions
            io.to(roomcode).emit('update player positions', room.board.players)
        }
    })

    socket.on('chat message', function (text) {
        if (!socket.gameRoom) return
        const roomcode = socket.gameRoom
        const username = rooms[roomcode].players[socket.playerID].username
        text = sanitize(text).trim()

        // Check some basic anti spam stuff
        if (socket.lastChat && (Date.now() - socket.lastChat) < 500) return
        if (text.length < 1) return

        socket.lastChat = Date.now()
        io.to(roomcode).emit('chat message', username, text)
    })

    socket.on('disconnect', function () {
        if (socket.gameRoom) {
            removePlayer(socket.gameRoom, socket.playerID)
        }
    })

    socket.on('movement test', function (direction) {
        // Don't let players move too quickly
        if (performance.now() - socket.lastMove < 500) return
        const roomcode = socket.gameRoom
        const room = rooms[roomcode]

        // Don't let players backtrack
        let reverse = room.board.reverseDirection(direction)
        if (socket.lastDirection && socket.lastDirection[0] == reverse[0] && socket.lastDirection[1] == reverse[1]) return

        // Update player movement (if valid)
        const newTile = room.board.attemptMove(socket.playerID, direction)
        if (newTile) {
            socket.lastMove = performance.now()
            socket.lastDirection = direction
            io.to(roomcode).emit('animate fox', socket.playerID, newTile.x, newTile.y, newTile.type)
        }
    })
})