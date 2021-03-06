import express from 'express'
import http from 'http'
import path from 'path'
import { BoardManager } from './BoardManager'

// Setup express to simply serve the public directory
const app = express()
app.use(express.static('public'))

app.get('*', (req, res) => {
    res.sendFile(path.resolve('public/index.html'))
})

// Setup an HTTP server on the given port
// We'll link up all our IO stuff to this server
const port = process.env.PORT || 3000
export const server = new http.Server(app)
server.listen(port, () => {
    console.log('Server started on *:3000')
    BoardManager.loadBoardData()
})