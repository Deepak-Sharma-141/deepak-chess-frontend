      const BACKEND_URL = 'https://chess-backend-hu0h.onrender.com/api';
    //  const BACKEND_URL ='deepak-chess-backend-production.up.railway.app';
     
class ChessGame {
    constructor() {
        this.board = this.initializeBoard();
        this.currentPlayer = 'white';
        this.selectedSquare = null;
        this.gameOver = false;
        this.capturedPieces = { white: [], black: [] };
        this.kings = { white: { row: 7, col: 4 }, black: { row: 0, col: 4 } };
        this.moveHistory = [];
        this.lastMove = null;
        this.pendingPromotion = null;

        //timer properties
        this.timerEnabled = false;
        this.timePerPlayer = 10 * 60; // 10 minutes default
        this.whiteTimeLeft = this.timePerPlayer;
        this.blackTimeLeft = this.timePerPlayer;
        this.timerInterval = null;
        this.gameStarted = false;
        
        // Multiplayer properties
        this.isMultiplayer = false;
        this.playerId = this.generatePlayerId();
        this.playerName = '';
        this.playerColor = null;
        this.gameId = null;
        this.stompClient = null;
        this.connected = false;
        this.bothPlayersReady = false;


        this.initializeGame();
        this.updateControlStates();
    }

    generatePlayerId() {
        return 'player_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    connectToServer() {
        return new Promise((resolve, reject) => {
            try {
                console.log('Attempting to connect to:', BACKEND_URL + '/chess-websocket');
                
                // Check if we're in a secure context
                if (location.protocol === 'https:' && BACKEND_URL.startsWith('https:')) {
                    console.log('Secure connection detected');
                    this.hideSecurityWarning();
                } else if (location.protocol === 'http:' && BACKEND_URL.startsWith('http:')) {
                    console.log('HTTP connection detected');
                    this.hideSecurityWarning();
                } else {
                    console.warn('Mixed content detected - this may cause security warnings');
                    this.showSecurityWarning();
                }
                
                const socket = new SockJS(BACKEND_URL + '/chess-websocket');
                this.stompClient = Stomp.over(socket);
                
                // Enable debug logging
                this.stompClient.debug = (str) => {
                    console.log('STOMP Debug:', str);
                };
                
                this.updateGameStatus('Connecting to server...', 'connecting');
                
                // Set connection timeout
                const connectionTimeout = setTimeout(() => {
                    if (!this.connected) {
                        console.error('Connection timeout');
                        this.updateGameStatus('Connection timeout - server may be down', 'disconnected');
                        reject(new Error('Connection timeout'));
                    }
                }, 10000); // 10 second timeout
                
                this.stompClient.connect({}, 
                    (frame) => {
                        clearTimeout(connectionTimeout);
                        console.log('Connected successfully:', frame);
                        this.connected = true;
                        this.updateGameStatus('Connected to server', 'connected');
                        resolve();
                    },
                    (error) => {
                        clearTimeout(connectionTimeout);
                        console.error('Connection error:', error);
                        this.connected = false;
                        
                        // Provide more specific error messages
                        let errorMessage = 'Failed to connect to server';
                        if (error.includes('timeout')) {
                            errorMessage = 'Connection timeout - server may be down';
                        } else if (error.includes('CORS')) {
                            errorMessage = 'CORS error - check server configuration';
                        } else if (error.includes('Mixed Content')) {
                            errorMessage = 'Mixed content error - use HTTPS';
                        }
                        
                        this.updateGameStatus(errorMessage, 'disconnected');
                        reject(error);
                    }
                );
            } catch (error) {
                console.error('Failed to create WebSocket connection:', error);
                this.updateGameStatus('Failed to create connection', 'disconnected');
                reject(error);
            }
        });
    }


// Alternative configuration object (recommended)

    disconnectFromServer() {
        if (this.stompClient && this.connected) {
            if (this.gameId) {
                const disconnectMessage = {
                    type: 'disconnect',
                    playerId: this.playerId,
                    playerName: this.playerName
                };
                this.stompClient.send(`/app/game/${this.gameId}/disconnect`, {}, JSON.stringify(disconnectMessage));
            }
            this.stompClient.disconnect();
            this.connected = false;
            this.updateGameStatus('Disconnected from server', 'disconnected');
        }
    }

    subscribeToGame(gameId) {
        if (!this.stompClient || !this.connected) {
            console.error('Cannot subscribe to game: stompClient=', !!this.stompClient, 'connected=', this.connected);
            return;
        }

        console.log('Subscribing to game channels for gameId:', gameId);
        
        this.stompClient.subscribe(`/topic/game/${gameId}`, (message) => {
            console.log('Received game message:', message.body);
            try {
                const gameMessage = JSON.parse(message.body);
                this.handleGameMessage(gameMessage);
            } catch (error) {
                console.error('Error parsing game message:', error, message.body);
            }
        });

        this.stompClient.subscribe(`/topic/game/${gameId}/player/${this.playerId}`, (message) => {
            console.log('Received player message:', message.body);
            try {
                const gameMessage = JSON.parse(message.body);
                this.handlePlayerMessage(gameMessage);
            } catch (error) {
                console.error('Error parsing player message:', error, message.body);
            }
        });
        
        console.log('Successfully subscribed to game channels');
    }

    handleGameMessage(message) {
        console.log('Game message received:', message);
        switch (message.type) {
            case 'move':
                this.handleRemoteMove(message);
                break;
            case 'moveError':
                console.error('Move error from server:', message.error);
                this.updateGameInfo(`Move error: ${message.error}`);
                break;
            case 'resign':
                // Opponent resigned
                this.gameOver = true;
                this.stopTimer?.();
                document.getElementById('gameStatus').innerHTML = `<span class="checkmate">${(this.playerColor).charAt(0).toUpperCase() + (this.playerColor).slice(1)} wins by resignation</span>`;
                this.updateControlStates();
                break;
            case 'drawOffer':
                // Opponent offered a draw – prompt user
                if (!this.gameOver) {
                    const accept = confirm('Opponent offered a draw. Do you accept?');
                    if (accept) {
                        this.gameOver = true;
                        this.stopTimer?.();
                        document.getElementById('gameStatus').innerHTML = `<span class=\"checkmate\">Game ended in a draw (mutual agreement)</span>`;
                        if (this.isMultiplayer && this.stompClient && this.connected && this.gameId) {
                            const resp = { type: 'drawAccept', playerId: this.playerId };
                            this.stompClient.send(`/app/game/${this.gameId}/draw-accept`, {}, JSON.stringify(resp));
                        }
                        this.updateControlStates();
                    } else {
                        if (this.isMultiplayer && this.stompClient && this.connected && this.gameId) {
                            const resp = { type: 'drawDecline', playerId: this.playerId };
                            this.stompClient.send(`/app/game/${this.gameId}/draw-decline`, {}, JSON.stringify(resp));
                        }
                        this.updateGameInfo('You declined the draw offer.');
                    }
                }
                break;
            case 'drawAccept':
                this.gameOver = true;
                this.stopTimer?.();
                document.getElementById('gameStatus').innerHTML = `<span class=\"checkmate\">Game ended in a draw (mutual agreement)</span>`;
                this.updateControlStates();
                break;
            case 'playerJoined':
                this.updateGameInfo(`${message.playerName} joined the game`);
                if (message.gameState) {
                    this.updateFromGameState(message.gameState);
                }
                break;
            case 'playerDisconnected':
                this.updateGameInfo(`${message.playerName} disconnected`);
                break;
            case 'gameStart':
                this.updateGameInfo('Game started! Both players connected.');
                if (message.gameState) {
                    this.updateFromGameState(message.gameState);
                }
                break;
            case 'gameEnd':
                this.handleGameEnd(message.gameState);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }

    setupTimer() {
        const enableTimer = document.getElementById('enableRightTimer');
        const timerSelect = document.getElementById('rightTimerSelect');
        
        // Prevent enabling timer after the game has started (local or multiplayer)
        if (enableTimer && enableTimer.checked && this.gameStarted) {
            this.updateGameInfo('You cannot enable the timer after the game has started.');
            enableTimer.checked = false;
            this.timerEnabled = false;
            this.updateTimerDisplay();
            return;
        }

        this.timerEnabled = !!(enableTimer && enableTimer.checked);
        if (this.timerEnabled && timerSelect) {
            this.timePerPlayer = parseInt(timerSelect.value);
            this.whiteTimeLeft = this.timePerPlayer;
            this.blackTimeLeft = this.timePerPlayer;
        }
        this.updateTimerDisplay();
    }

    startTimer() {
        if (!this.timerEnabled) return;
        this.stopTimer();
        this.timerInterval = setInterval(() => {
            if (this.currentPlayer === 'white') {
                this.whiteTimeLeft--;
            } else {
                this.blackTimeLeft--;
            }
            this.updateTimerDisplay();
            if (this.whiteTimeLeft <= 0) {
                this.endGameByTimeout('black');
            } else if (this.blackTimeLeft <= 0) {
                this.endGameByTimeout('white');
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    updateTimerDisplay() {
        const leftTimerContainer = document.getElementById('leftTimer');
        const rightTimerContainer = document.getElementById('rightTimer');
        const leftTimerDisplay = document.getElementById('leftTimerDisplay');
        const rightTimerDisplay = document.getElementById('rightTimerDisplay');
        
        if (leftTimerDisplay) leftTimerDisplay.textContent = this.formatTime(this.whiteTimeLeft);
        if (rightTimerDisplay) rightTimerDisplay.textContent = this.formatTime(this.blackTimeLeft);
        const shouldHighlightWhite = this.timerEnabled && this.gameStarted && this.currentPlayer === 'white';
        const shouldHighlightBlack = this.timerEnabled && this.gameStarted && this.currentPlayer === 'black';
        if (leftTimerContainer) {
            leftTimerContainer.classList.toggle('active', shouldHighlightWhite);
            leftTimerContainer.classList.toggle('low-time', this.timerEnabled && this.whiteTimeLeft < 60);
        }
        if (rightTimerContainer) {
            rightTimerContainer.classList.toggle('active', shouldHighlightBlack);
            rightTimerContainer.classList.toggle('low-time', this.timerEnabled && this.blackTimeLeft < 60);
        }
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    endGameByTimeout(winner) {
        this.gameOver = true;
        this.updateControlStates();
        document.getElementById('gameStatus').innerHTML = 
            `<span class="checkmate">${winner.charAt(0).toUpperCase() + winner.slice(1)} wins by timeout!</span>`;
    }

    handlePlayerMessage(message) {
        console.log('Player message received:', message);
        switch (message.type) {
            case 'gameJoined':
                this.handleGameJoined(message.gameState);
                break;
            case 'error':
                alert('Error: ' + message.error);
                break;
        }
    }

    updateGameStatus(status, type = 'info') {
        const statusElement = document.getElementById('connectionStatus');
        statusElement.textContent = status;
        statusElement.className = `connection-status status-${type}`;
    }

    updateGameInfo(info) {
        const infoElement = document.getElementById('gameInfoPanel');
        infoElement.textContent = info;
    }

    showSecurityWarning() {
        const warningElement = document.getElementById('securityWarning');
        if (warningElement) {
            warningElement.style.display = 'flex';
        }
    }

    hideSecurityWarning() {
        const warningElement = document.getElementById('securityWarning');
        if (warningElement) {
            warningElement.style.display = 'none';
        }
    }

    async createMultiplayerGame() {
        const playerName = document.getElementById('playerNameInput').value.trim();
        if (!playerName) {
            alert('Please enter your name');
            return;
        }
        
        this.playerName = playerName;
        
        try {
            await this.connectToServer();
            
            const response = await fetch(`${BACKEND_URL}/api/games/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    playerId: this.playerId, 
                    playerName: this.playerName 
                })
            });
            
            if (response.ok) {
                const gameSession = await response.json();
                console.log('Game created:', gameSession);
                
                this.gameId = gameSession.gameId;
                this.isMultiplayer = true;
                this.playerColor = 'white'; // Creator is always white
                
                this.subscribeToGame(this.gameId);
                this.updateGameInfo(`Game created! Share this ID: ${this.gameId}. Waiting for opponent...`);
                closeMultiplayerMenu();
            } else {
                const errorText = await response.text();
                console.error('Failed to create game:', errorText);
                throw new Error('Failed to create game: ' + errorText);
            }
        } catch (error) {
            console.error('Error creating game:', error);
            alert('Failed to create game: ' + error.message);
        }
}
    // async joinRandomGame() {
    //     const playerName = document.getElementById('playerNameInput').value.trim();
    //     if (!playerName) { alert('Please enter your name'); return; }
    //     this.playerName = playerName;
    //     try {
    //         await this.connectToServer();
    //         const response = await fetch(`${BACKEND_URL}/api/games/join-random`, {
    //             method: 'POST', headers: { 'Content-Type': 'application/json' },
    //             body: JSON.stringify({ playerId: this.playerId, playerName: this.playerName })
    //         });
    //         if (response.ok) {
    //             const gameSession = await response.json();
    //             if (gameSession) {
    //                 this.handleGameJoined(gameSession);
    //                 closeMultiplayerMenu();
    //             } else {
    //                 alert('No available games to join. Try creating a new game.');
    //             }
    //         } else { throw new Error('Failed to join random game'); }
    //     } catch (error) {
    //         console.error('Error joining random game:', error);
    //         alert('Failed to join game. Make sure the server is running on localhost:8080');
    //     }
    // }

    async joinRandomGame() {
    const nameInput = document.getElementById('playerNameInput');
    playerName = nameInput.value.trim();
    
    if (!playerName) {
        alert('Please enter your name first');
        return;
    }
    
    // Show waiting status
    showWaitingStatus('Searching for an opponent...');
    
    // Connect to WebSocket if not already connected
    if (!isConnected) {
        connectToWebSocket(() => {
            requestRandomMatch();
        });
    } else {
        requestRandomMatch();
    }
}

    async joinSpecificGame() {
        const playerName = document.getElementById('playerNameInput').value.trim();
        const gameId = document.getElementById('gameIdInput').value.trim();
        if (!playerName) { alert('Please enter your name'); return; }
        if (!gameId) { alert('Please enter a game ID'); return; }
        this.playerName = playerName;
        this.gameId = gameId;
        try {
            await this.connectToServer();
            const joinMessage = { type: 'join', playerId: this.playerId, playerName: this.playerName };
            this.subscribeToGame(this.gameId);
            this.stompClient.send(`/app/game/${this.gameId}/join`, {}, JSON.stringify(joinMessage));
            this.updateGameInfo(`Attempting to join game ${this.gameId}...`);
            closeMultiplayerMenu();
        } catch (error) {
            console.error('Error joining specific game:', error);
            alert('Failed to connect to game. Make sure the server is running and the game ID is correct.');
        }
    }

        handleGameJoined(gameState) {
            this.isMultiplayer = true;
            this.gameId = gameState.gameId;
            
            console.log('Game state received:', gameState);
            console.log('My player ID:', this.playerId);
            
            // Fixed player color assignment - backend sends Player objects with 'id' field
            if (gameState.whitePlayer && gameState.whitePlayer.id === this.playerId) {
                this.playerColor = 'white';
            } else if (gameState.blackPlayer && gameState.blackPlayer.id === this.playerId) {
                this.playerColor = 'black';
            } else {
                // Fallback: assign based on available slots
                if (!gameState.whitePlayer) {
                    this.playerColor = 'white';
                } else if (!gameState.blackPlayer) {
                    this.playerColor = 'black';
                } else {
                    console.error('Could not determine player color!');
                    this.playerColor = null;
                }
            }
            
            // Critical check to ensure player color was assigned
            if (!this.playerColor) {
                console.error('Player color assignment failed! GameState:', gameState);
                this.updateGameInfo('Error: Could not determine your color. Try rejoining the game.');
                return;
            }
            
            console.log('Final player color assignment:', this.playerColor);
            
            this.bothPlayersReady = !!(gameState.whitePlayer && gameState.blackPlayer);
            this.gameStarted = gameState.gameStatus === 'active' && this.bothPlayersReady;
            this.updateControlStates();
            
            if (!this.bothPlayersReady) {
                this.updateGameInfo(`Waiting for opponent... Share game ID: ${this.gameId}`);
            } else {
                this.updateGameInfo(`Game ready. You are ${this.playerColor}. ${this.currentPlayer === 'white' ? 'White' : 'Black'} to move.`);
            }
        }

    handleRemoteMove(message) {
        if (message.move) {
            const move = message.move;
            this.applyMoveFromServer(move);
            if (message.gameState) {
                this.updateFromGameState(message.gameState);
            }
        }
    }

    applyMoveFromServer(move) {
        const piece = this.board[move.fromRow][move.fromCol];
        const capturedPiece = this.board[move.toRow][move.toCol];
        if (capturedPiece) this.capturedPieces[capturedPiece.color].push(capturedPiece);
        this.board[move.toRow][move.toCol] = piece;
        this.board[move.fromRow][move.fromCol] = null;
        if (piece && piece.type === 'king') this.kings[piece.color] = { row: move.toRow, col: move.toCol };
        this.moveHistory.push({ player: move.playerColor, notation: move.notation, fullMove: Math.floor(this.moveHistory.length / 2) + 1 });
        this.updateDisplay();
    }

    // Add this method to your frontend ChessGame class
updateBoardFromServer(serverBoardState) {
    try {
        console.log('Syncing board from server:', serverBoardState);
        const boardData = JSON.parse(serverBoardState);
        const serverBoard = boardData.board;
        
        // Convert server format to frontend format
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (serverBoard[row][col]) {
                    const [color, type] = serverBoard[row][col].split('_');
                    this.board[row][col] = { type, color };
                } else {
                    this.board[row][col] = null;
                }
            }
        }
        
        // Update kings positions
        this.updateKingsFromBoard();
        console.log('Board synced successfully from server');
    } catch (error) {
        console.error('Failed to sync board from server:', error);
    }
}

updateKingsFromBoard() {
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = this.board[row][col];
            if (piece && piece.type === 'king') {
                this.kings[piece.color] = { row, col };
            }
        }
    }
}

    // Modify your updateFromGameState method
    updateFromGameState(gameState) {
            if (!gameState) return;
            
            // Sync board state from server
            if (gameState.boardState) {
                this.updateBoardFromServer(gameState.boardState);
            }
            
            // Rest of your existing code...
            this.bothPlayersReady = !!(gameState.whitePlayer && gameState.blackPlayer);
            this.currentPlayer = gameState.currentTurn;
            // ... etc
        }

    updateFromGameState(gameState) {
    console.log('=== UPDATING FROM GAME STATE ===');
    console.log('Received gameState:', gameState);

    if (!gameState) return;
    
    // Update game state from server
    this.bothPlayersReady = !!(gameState.whitePlayer && gameState.blackPlayer);
    this.currentPlayer = gameState.currentTurn;
    this.gameStarted = gameState.gameStatus === 'active' && this.bothPlayersReady;
    this.gameOver = gameState.gameStatus === 'finished';

    console.log('Updated values:');
    console.log('bothPlayersReady:', this.bothPlayersReady);
    console.log('currentPlayer:', this.currentPlayer);
    console.log('gameStarted:', this.gameStarted);
    console.log('gameOver:', this.gameOver);
    console.log('================================');
        
    // Update board state if provided
    if (gameState.boardState) {
        this.updateBoardFromServer(gameState.boardState);
    }
    
    // Update captured pieces if provided
    if (gameState.capturedPieces) {
        this.capturedPieces = gameState.capturedPieces;
    }
    
    // Update move history if provided
    if (gameState.moveHistory) {
        this.moveHistory = gameState.moveHistory;
    }
    
    // Start timer if game is active and timer is enabled
    if (this.timerEnabled && this.gameStarted && !this.timerInterval) {
        this.startTimer();
    } else if (!this.timerEnabled && this.timerInterval) {
        // Stop timer if it's running but shouldn't be
        this.stopTimer();
    }
    
    this.updateStatus();
    this.updateControlStates();
    this.updateDisplay();
}
   sendMove(fromRow, fromCol, toRow, toCol) {
    console.log('sendMove called with:', { fromRow, fromCol, toRow, toCol });
    
    if (!this.isMultiplayer || !this.stompClient || !this.connected) {
        console.error('Cannot send move:', {
            multiplayer: this.isMultiplayer, 
            stompClient: !!this.stompClient, 
            connected: this.connected
        });
        this.updateGameInfo('Error: Not connected to multiplayer server');
        return;
    }
    
    if (!this.bothPlayersReady) {
        this.updateGameInfo('Waiting for opponent to join...');
        return;
    }
    
    if (!this.playerColor) {
        console.error('Player color not set when sending move!');
        this.updateGameInfo('Error: Player color not assigned');
        return;
    }
    
    if (this.playerColor !== this.currentPlayer) {
        this.updateGameInfo('It\'s not your turn!');
        return;
    }
    
    const piece = this.board[fromRow][fromCol];
    
    if (!piece) {
        console.error('No piece at source square:', fromRow, fromCol);
        this.updateGameInfo('Error: No piece at selected square');
        return;
    }
    
    if (piece.color !== this.playerColor) {
        this.updateGameInfo('You can only move your own pieces!');
        return;
    }
    
    const capturedPiece = this.board[toRow][toCol];
    
    const move = {
        fromRow, fromCol, toRow, toCol,
        playerId: this.playerId,
        playerColor: this.playerColor,
        piece: piece.type,
        capturedPiece: capturedPiece ? capturedPiece.type : null,
        notation: this.generateNotation(fromRow, fromCol, toRow, toCol),
        timestamp: new Date().toISOString()
    };
    
    const moveMessage = { type: 'move', playerId: this.playerId, move };
    console.log('Sending move to server:', moveMessage);
    
    try {
        this.stompClient.send(`/app/game/${this.gameId}/move`, {}, JSON.stringify(moveMessage));
        console.log('Move sent successfully');
        
        // Temporarily disable moves until server response
        this.clearSelection();
    } catch (error) {
        console.error('Error sending move:', error);
        this.updateGameInfo('Error sending move to server');
    }
}

    generateNotation(fromRow, fromCol, toRow, toCol) {
        const piece = this.board[fromRow][fromCol];
        const captured = this.board[toRow][toCol];
        const fromSquare = String.fromCharCode(97 + fromCol) + (8 - fromRow);
        const toSquare = String.fromCharCode(97 + toCol) + (8 - toRow);
        let notation = '';
        if (piece.type === 'pawn') {
            notation = captured ? (fromSquare[0] + 'x' + toSquare) : toSquare;
        } else {
            const pieceSymbol = piece.type.charAt(0).toUpperCase();
            notation = pieceSymbol + (captured ? ('x' + toSquare) : toSquare);
        }
        return notation;
    }

    handleGameEnd(gameState) {
        this.gameOver = true;
        const winner = gameState.winner;
        const message = winner === 'draw' ? 'Game ended in a draw' : `${winner.charAt(0).toUpperCase() + winner.slice(1)} wins!`;
        document.getElementById('gameStatus').innerHTML = `<span class="checkmate">${message}</span>`;
        this.updateControlStates();
    }

    resign() {
        if (this.gameOver) return;
        const loser = this.isMultiplayer ? this.playerColor : this.currentPlayer;
        const winner = loser === 'white' ? 'black' : 'white';
        this.gameOver = true;
        this.stopTimer?.();
        document.getElementById('gameStatus').innerHTML = `<span class="checkmate">${winner.charAt(0).toUpperCase() + winner.slice(1)} wins by resignation</span>`;
        if (this.isMultiplayer && this.stompClient && this.connected && this.gameId) {
            const msg = { type: 'resign', playerId: this.playerId };
            this.stompClient.send(`/app/game/${this.gameId}/resign`, {}, JSON.stringify(msg));
        }
        this.updateControlStates();
    }

    offerDraw() {
        if (this.gameOver) return;
        if (!this.isMultiplayer) {
            // Local: immediate draw confirmation
            this.gameOver = true;
            this.stopTimer?.();
            document.getElementById('gameStatus').innerHTML = `<span class="checkmate">Game ended in a draw (mutual agreement)</span>`;
            return;
        }
        if (this.isMultiplayer && this.stompClient && this.connected && this.gameId) {
            const msg = { type: 'drawOffer', playerId: this.playerId };
            this.stompClient.send(`/app/game/${this.gameId}/draw-offer`, {}, JSON.stringify(msg));
            this.updateGameInfo('Draw offer sent. Waiting for opponent response...');
        }
    }

    resetToLocal() {
        this.isMultiplayer = false;
        this.disconnectFromServer();
        this.gameId = null;
        this.playerColor = null;
        this.updateGameStatus('Local Game Mode');
        this.updateGameInfo('');
        this.updateControlStates();
    }

    initializeBoard() {
        const board = Array(8).fill(null).map(() => Array(8).fill(null));
        for (let col = 0; col < 8; col++) {
            board[1][col] = { type: 'pawn', color: 'black' };
            board[6][col] = { type: 'pawn', color: 'white' };
        }
        const backRow = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
        for (let col = 0; col < 8; col++) {
            board[0][col] = { type: backRow[col], color: 'black' };
            board[7][col] = { type: backRow[col], color: 'white' };
        }
        return board;
    }

   initializeGame() {
        this.renderBoard();
        this.updateStatus();
        this.setupTimer();
        if (this.timerEnabled && (!this.isMultiplayer || this.gameStarted)) {
            this.startTimer();
        }
        // Removed per-instance DOM event listeners to avoid stale handlers across New Game resets
    }

    renderBoard() {
        const chessboard = document.getElementById('chessboard');
        chessboard.innerHTML = '';
        const flipBoard =this.isMultiplayer && this.playerColor === 'black';
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const actualRow =flipBoard ? 7 - row : row;
                const actualCol =flipBoard ? 7 -col : col;
                const square = document.createElement('div');
                square.className = `square ${(actualRow + actualCol) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.actualRow = actualRow;
                square.dataset.actualCol = actualCol;
                square.onclick = () => this.handleSquareClick(actualRow, actualCol);
                const piece = this.board[actualRow][actualCol];
                if (piece) {
                    const pieceElement = document.createElement('span');
                    pieceElement.className = `piece ${piece.color}`;
                    pieceElement.textContent = this.getPieceSymbol(piece);
                    square.appendChild(pieceElement);
                }
                chessboard.appendChild(square);
            }
        }
    }

    getPieceSymbol(piece) {
        const symbols = {
            white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
            black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' }
        };

         if (this.isMultiplayer && this.playerColor) {
        // Show your pieces as white symbols, opponent pieces as black symbols
        const displayColor = (piece.color === this.playerColor) ? 'white' : 'black';
        return symbols[displayColor][piece.type];
    }
        return symbols[piece.color][piece.type];
    }

handleSquareClick(row, col) {
    if (this.gameOver || this.pendingPromotion) return;
    
    // Enhanced debugging
    console.log('=== CLICK DEBUG ===');
    console.log('isMultiplayer:', this.isMultiplayer);
    console.log('bothPlayersReady:', this.bothPlayersReady);
    console.log('playerColor:', this.playerColor);
    console.log('currentPlayer:', this.currentPlayer);
    console.log('gameStarted:', this.gameStarted);
    console.log('clicked piece:', this.board[row][col]);
    console.log('==================');
    
    // Multiplayer validation with better debugging
    if (this.isMultiplayer) {
        if (!this.bothPlayersReady) { 
            console.log('BLOCKED: Waiting for opponent');
            this.updateGameInfo('Waiting for opponent to join...'); 
            return; 
        }
        
        if (!this.playerColor) {
            console.log('BLOCKED: No player color');
            this.updateGameInfo('Error: Player color not assigned. Try rejoining the game.');
            return;
        }
        
        if (this.playerColor !== this.currentPlayer) { 
            console.log('BLOCKED: Not your turn - playerColor:', this.playerColor, 'currentPlayer:', this.currentPlayer);
            this.updateGameInfo(`It's not your turn! You are ${this.playerColor}, current turn: ${this.currentPlayer}`); 
            return; 
        }
    }
    
    const piece = this.board[row][col];
    console.log('Clicked piece:', piece);
            
    if (this.selectedSquare) {
        const [selectedRow, selectedCol] = this.selectedSquare;
        
        if (row === selectedRow && col === selectedCol) { 
            this.clearSelection(); 
            return; 
        }
        
        if (this.isValidMove(selectedRow, selectedCol, row, col)) {
            if (this.isMultiplayer) { 
                console.log('Sending move to server...');
                this.sendMove(selectedRow, selectedCol, row, col); 
            } else { 
                this.makeMove(selectedRow, selectedCol, row, col); 
            }
            this.clearSelection();
        } else {
            if (piece && piece.color === this.currentPlayer) {
                if (!this.isMultiplayer || piece.color === this.playerColor) {
                    this.selectSquare(row, col);
                }
            } else {
                this.clearSelection();
            }
        }
    } else {
        if (piece && piece.color === this.currentPlayer) {
            if (!this.isMultiplayer || piece.color === this.playerColor) {
                this.selectSquare(row, col);
            } else {
                this.updateGameInfo(`You can only move ${this.playerColor} pieces!`);
            }
        }
    }
}

    selectSquare(row, col) {
        this.clearHighlights();
        this.selectedSquare = [row, col];
        this.highlightSquare(row, col, 'selected');
        this.highlightValidMoves(row, col);
    }

    clearSelection() { this.selectedSquare = null; this.clearHighlights(); }

   highlightSquare(row, col, className) {
       const square = document.querySelector(`[data-actual-row="${row}"][data-actual-col="${col}"]`);
           if (square) square.classList.add(className);
    }

    clearHighlights() { document.querySelectorAll('.square').forEach(sq => sq.classList.remove('selected', 'valid-move', 'capture-move')); }

    highlightValidMoves(row, col) {
        const validMoves = this.getValidMoves(row, col);
        validMoves.forEach(([moveRow, moveCol]) => {
            const targetPiece = this.board[moveRow][moveCol];
            const className = targetPiece ? 'capture-move' : 'valid-move';
            this.highlightSquare(moveRow, moveCol, className);
        });
    }

    getValidMoves(row, col) {
        const piece = this.board[row][col];
        if (!piece) return [];
        let moves = [];
        switch (piece.type) {
            case 'pawn': moves = this.getPawnMoves(row, col, piece.color); break;
            case 'rook': moves = this.getRookMoves(row, col); break;
            case 'knight': moves = this.getKnightMoves(row, col); break;
            case 'bishop': moves = this.getBishopMoves(row, col); break;
            case 'queen': moves = [...this.getRookMoves(row, col), ...this.getBishopMoves(row, col)]; break;
            case 'king': moves = this.getKingMoves(row, col); break;
        }
        return moves.filter(([toRow, toCol]) => !this.wouldBeInCheck(row, col, toRow, toCol, piece.color));
    }

    getPawnMoves(row, col, color) {
        const moves = [];
        const direction = color === 'white' ? -1 : 1;
        const startRow = color === 'white' ? 6 : 1;
        if (this.isValidSquare(row + direction, col) && !this.board[row + direction][col]) {
            moves.push([row + direction, col]);
            if (row === startRow && !this.board[row + 2 * direction][col]) moves.push([row + 2 * direction, col]);
        }
        for (const dcol of [-1, 1]) {
            const newRow = row + direction;
            const newCol = col + dcol;
            if (this.isValidSquare(newRow, newCol)) {
                const targetPiece = this.board[newRow][newCol];
                if (targetPiece && targetPiece.color !== color) moves.push([newRow, newCol]);
                else if (this.isEnPassant(row, col, newRow, newCol, color)) moves.push([newRow, newCol]);
            }
        }
        return moves;
    }

    getRookMoves(row, col) {
        const moves = [];
        const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [drow, dcol] of directions) {
            for (let i = 1; i < 8; i++) {
                const newRow = row + i * drow;
                const newCol = col + i * dcol;
                if (!this.isValidSquare(newRow, newCol)) break;
                const targetPiece = this.board[newRow][newCol];
                if (!targetPiece) moves.push([newRow, newCol]);
                else { if (targetPiece.color !== this.board[row][col].color) moves.push([newRow, newCol]); break; }
            }
        }
        return moves;
    }

    getBishopMoves(row, col) {
        const moves = [];
        const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        for (const [drow, dcol] of directions) {
            for (let i = 1; i < 8; i++) {
                const newRow = row + i * drow;
                const newCol = col + i * dcol;
                if (!this.isValidSquare(newRow, newCol)) break;
                const targetPiece = this.board[newRow][newCol];
                if (!targetPiece) moves.push([newRow, newCol]);
                else { if (targetPiece.color !== this.board[row][col].color) moves.push([newRow, newCol]); break; }
            }
        }
        return moves;
    }

    getKnightMoves(row, col) {
        const moves = [];
        const knightMoves = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        for (const [drow, dcol] of knightMoves) {
            const newRow = row + drow;
            const newCol = col + dcol;
            if (this.isValidSquare(newRow, newCol)) {
                const targetPiece = this.board[newRow][newCol];
                if (!targetPiece || targetPiece.color !== this.board[row][col].color) moves.push([newRow, newCol]);
            }
        }
        return moves;
    }

    getKingMoves(row, col) {
        const moves = [];
        const kingMoves = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
        for (const [drow, dcol] of kingMoves) {
            const newRow = row + drow;
            const newCol = col + dcol;
            if (this.isValidSquare(newRow, newCol)) {
                const targetPiece = this.board[newRow][newCol];
                if (!targetPiece || targetPiece.color !== this.board[row][col].color) moves.push([newRow, newCol]);
            }
        }
        if (this.canCastle(row, col, 'kingside')) moves.push([row, col + 2]);
        if (this.canCastle(row, col, 'queenside')) moves.push([row, col - 2]);
        return moves;
    }

    canCastle(kingRow, kingCol, side) {
        const piece = this.board[kingRow][kingCol];
        if (!piece || piece.type !== 'king') return false;
        const color = piece.color;
        const expectedRow = color === 'white' ? 7 : 0;
        const expectedCol = 4;
        if (kingRow !== expectedRow || kingCol !== expectedCol) return false;
        const enemyColor = color === 'white' ? 'black' : 'white';
        if (this.isSquareAttacked(kingRow, kingCol, enemyColor)) return false;
        const rookCol = side === 'kingside' ? 7 : 0;
        const rook = this.board[expectedRow][rookCol];
        if (!rook || rook.type !== 'rook' || rook.color !== color) return false;
        const startCol = side === 'kingside' ? kingCol + 1 : rookCol + 1;
        const endCol = side === 'kingside' ? rookCol : kingCol;
        for (let col = startCol; col < endCol; col++) {
            if (this.board[expectedRow][col]) return false;
            if (col >= kingCol - 1 && col <= kingCol + 1) {
                if (this.isSquareAttacked(expectedRow, col, enemyColor)) return false;
            }
        }
        return true;
    }

    isValidSquare(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }
    isValidMove(fromRow, fromCol, toRow, toCol) { return this.getValidMoves(fromRow, fromCol).some(([r, c]) => r === toRow && c === toCol); }

    wouldBeInCheck(fromRow, fromCol, toRow, toCol, color) {
        const originalPiece = this.board[toRow][toCol];
        const movingPiece = this.board[fromRow][fromCol];
        this.board[toRow][toCol] = movingPiece;
        this.board[fromRow][fromCol] = null;
        let kingRow = this.kings[color].row;
        let kingCol = this.kings[color].col;
        if (movingPiece.type === 'king') { kingRow = toRow; kingCol = toCol; }
        const inCheck = this.isSquareAttacked(kingRow, kingCol, color === 'white' ? 'black' : 'white');
        this.board[fromRow][fromCol] = movingPiece;
        this.board[toRow][toCol] = originalPiece;
        return inCheck;
    }

    isSquareAttacked(row, col, byColor) {
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = this.board[r][c];
                if (piece && piece.color === byColor) {
                    if (this.canPieceAttackSquare(r, c, row, col)) return true;
                }
            }
        }
        return false;
    }

    canPieceAttackSquare(pieceRow, pieceCol, targetRow, targetCol) {
        const piece = this.board[pieceRow][pieceCol];
        if (!piece) return false;
        switch (piece.type) {
            case 'pawn': return this.canPawnAttack(pieceRow, pieceCol, targetRow, targetCol, piece.color);
            case 'rook': return this.canRookAttack(pieceRow, pieceCol, targetRow, targetCol);
            case 'bishop': return this.canBishopAttack(pieceRow, pieceCol, targetRow, targetCol);
            case 'knight': return this.canKnightAttack(pieceRow, pieceCol, targetRow, targetCol);
            case 'queen': return this.canRookAttack(pieceRow, pieceCol, targetRow, targetCol) || this.canBishopAttack(pieceRow, pieceCol, targetRow, targetCol);
            case 'king': return this.canKingAttack(pieceRow, pieceCol, targetRow, targetCol);
            default: return false;
        }
    }

    canPawnAttack(row, col, targetRow, targetCol, color) { const direction = color === 'white' ? -1 : 1; return targetRow === row + direction && Math.abs(targetCol - col) === 1; }
    canRookAttack(row, col, targetRow, targetCol) { if (row !== targetRow && col !== targetCol) return false; const rowStep = row === targetRow ? 0 : (targetRow > row ? 1 : -1); const colStep = col === targetCol ? 0 : (targetCol > col ? 1 : -1); let currentRow = row + rowStep; let currentCol = col + colStep; while (currentRow !== targetRow || currentCol !== targetCol) { if (this.board[currentRow][currentCol]) return false; currentRow += rowStep; currentCol += colStep; } return true; }
    canBishopAttack(row, col, targetRow, targetCol) { if (Math.abs(targetRow - row) !== Math.abs(targetCol - col)) return false; const rowStep = targetRow > row ? 1 : -1; const colStep = targetCol > col ? 1 : -1; let currentRow = row + rowStep; let currentCol = col + colStep; while (currentRow !== targetRow || currentCol !== targetCol) { if (this.board[currentRow][currentCol]) return false; currentRow += rowStep; currentCol += colStep; } return true; }
    canKnightAttack(row, col, targetRow, targetCol) { const rowDiff = Math.abs(targetRow - row); const colDiff = Math.abs(targetCol - col); return (rowDiff === 2 && colDiff === 1) || (rowDiff === 1 && colDiff === 2); }
    canKingAttack(row, col, targetRow, targetCol) { const rowDiff = Math.abs(targetRow - row); const colDiff = Math.abs(targetCol - col); return rowDiff <= 1 && colDiff <= 1 && (rowDiff > 0 || colDiff > 0); }

    isEnPassant(row, col, targetRow, targetCol, color) {
        if (!this.lastMove) return false;
        const { from, to, piece } = this.lastMove;
        if (piece.type !== 'pawn') return false;
        if (Math.abs(from[0] - to[0]) !== 2) return false;
        const enemyRow = color === 'white' ? 3 : 4;
        if (row !== enemyRow) return false;
        if (to[1] !== targetCol) return false;
        if (to[0] !== row) return false;
        return true;
    }

    makeMove(fromRow, fromCol, toRow, toCol) {
        const piece = this.board[fromRow][fromCol];
        const capturedPiece = this.board[toRow][toCol];
        if (piece.type === 'king' && Math.abs(toCol - fromCol) === 2) {
            this.performCastling(fromRow, fromCol, toRow, toCol);
            this.switchPlayer();
            this.updateDisplay();
            return;
        }
        if (piece.type === 'pawn' && this.isEnPassant(fromRow, fromCol, toRow, toCol, piece.color)) {
            const capturedPawnRow = piece.color === 'white' ? 3 : 4;
            const capturedPawn = this.board[capturedPawnRow][toCol];
            this.board[capturedPawnRow][toCol] = null;
            this.capturedPieces[capturedPawn.color].push(capturedPawn);
        }
        if (capturedPiece) this.capturedPieces[capturedPiece.color].push(capturedPiece);
        this.board[toRow][toCol] = piece; this.board[fromRow][fromCol] = null;
        if (piece.type === 'king') this.kings[piece.color] = { row: toRow, col: toCol };
        this.lastMove = { from: [fromRow, fromCol], to: [toRow, toCol], piece: piece, captured: capturedPiece };
        if (piece.type === 'pawn' && (toRow === 0 || toRow === 7)) { this.pendingPromotion = { row: toRow, col: toCol, color: piece.color }; this.showPromotionDialog(piece.color); return; }
        if (!this.isMultiplayer && !this.gameStarted) { this.gameStarted = true; this.updateControlStates(); }
        this.addMoveToHistory(fromRow, fromCol, toRow, toCol, piece, capturedPiece);
        this.switchPlayer();
        this.updateDisplay();
    }

    performCastling(fromRow, fromCol, toRow, toCol) {
        const king = this.board[fromRow][fromCol];
        const side = toCol > fromCol ? 'kingside' : 'queenside';
        const rookFromCol = side === 'kingside' ? 7 : 0;
        const rookToCol = side === 'kingside' ? 5 : 3;
        this.board[toRow][toCol] = king; this.board[fromRow][fromCol] = null; this.kings[king.color] = { row: toRow, col: toCol };
        const rook = this.board[fromRow][rookFromCol]; this.board[fromRow][rookToCol] = rook; this.board[fromRow][rookFromCol] = null;
        const notation = side === 'kingside' ? 'O-O' : 'O-O-O';
        this.moveHistory.push({ player: this.currentPlayer, notation: notation, fullMove: Math.floor(this.moveHistory.length / 2) + 1 });
    }

    showPromotionDialog(color) {
        const modal = document.getElementById('promotionModal');
        const options = document.getElementById('promotionOptions');
        options.innerHTML = '';
        const pieces = ['queen', 'rook', 'bishop', 'knight'];
        pieces.forEach(pieceType => {
            const option = document.createElement('div');
            option.className = 'promotion-piece';
            option.textContent = this.getPieceSymbol({ type: pieceType, color: color });
            option.onclick = () => this.promoteTopiece(pieceType);
            options.appendChild(option);
        });
        modal.style.display = 'flex';
    }

    promoteTopiece(pieceType) {
        const { row, col, color } = this.pendingPromotion;
        this.board[row][col] = { type: pieceType, color: color };
        const moveCount = this.moveHistory.length;
        if (moveCount > 0) this.moveHistory[moveCount - 1].notation += '=' + pieceType.charAt(0).toUpperCase();
        this.pendingPromotion = null;
        document.getElementById('promotionModal').style.display = 'none';
        this.switchPlayer();
        this.updateDisplay();
    }

    addMoveToHistory(fromRow, fromCol, toRow, toCol, piece, captured) {
        const fromSquare = String.fromCharCode(97 + fromCol) + (8 - fromRow);
        const toSquare = String.fromCharCode(97 + toCol) + (8 - toRow);
        let notation = '';
        if (piece.type === 'pawn') notation = captured ? (fromSquare[0] + 'x' + toSquare) : toSquare;
        else {
            const pieceSymbol = piece.type.charAt(0).toUpperCase();
            notation = pieceSymbol + (captured ? ('x' + toSquare) : toSquare);
        }
        this.moveHistory.push({ player: this.currentPlayer, notation: notation, fullMove: Math.floor(this.moveHistory.length / 2) + 1 });
    }

    switchPlayer() {
        this.currentPlayer = this.currentPlayer === 'white' ? 'black' : 'white';
        if (this.timerEnabled && this.gameStarted) {
            if (!this.timerInterval) this.startTimer();
            else this.updateTimerDisplay();
        }
    }

    updateDisplay() {
        this.renderBoard();
        this.updateStatus();
        this.updateCapturedPieces();
        this.updateMoveHistory();
    }

    updateStatus() {
        const statusElement = document.getElementById('gameStatus');
        const currentPlayerElement = document.getElementById('currentPlayer');
        if (this.gameOver) return;
        const enemyColor = this.currentPlayer === 'white' ? 'black' : 'white';
        const kingPos = this.kings[this.currentPlayer];
        const inCheck = this.isSquareAttacked(kingPos.row, kingPos.col, enemyColor);
        if (inCheck) {
            if (this.isCheckmate(this.currentPlayer)) {
                statusElement.innerHTML = `<span class="checkmate">Checkmate! ${enemyColor.charAt(0).toUpperCase() + enemyColor.slice(1)} wins!</span>`;
                this.gameOver = true; return;
            } else {
                statusElement.innerHTML = `<span class="check-warning">${this.currentPlayer.charAt(0).toUpperCase() + this.currentPlayer.slice(1)} is in check!</span>`;
            }
        } else if (this.isStalemate(this.currentPlayer)) {
            statusElement.innerHTML = 'Stalemate! The game is a draw.';
            this.gameOver = true; return;
        } else {
            statusElement.textContent = '';
        }
        const playerText = this.isMultiplayer ? `${this.currentPlayer.charAt(0).toUpperCase() + this.currentPlayer.slice(1)}'s Turn` + (this.playerColor ? ` (You are ${this.playerColor})` : '') : `${this.currentPlayer.charAt(0).toUpperCase() + this.currentPlayer.slice(1)}'s Turn`;
        currentPlayerElement.textContent = playerText;
    }

    isCheckmate(color) {
        const kingPos = this.kings[color];
        const enemyColor = color === 'white' ? 'black' : 'white';
        if (!this.isSquareAttacked(kingPos.row, kingPos.col, enemyColor)) return false;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = this.board[row][col];
                if (piece && piece.color === color) {
                    const validMoves = this.getValidMoves(row, col);
                    if (validMoves.length > 0) return false;
                }
            }
        }
        return true;
    }

    isStalemate(color) {
        const kingPos = this.kings[color];
        const enemyColor = color === 'white' ? 'black' : 'white';
        if (this.isSquareAttacked(kingPos.row, kingPos.col, enemyColor)) return false;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = this.board[row][col];
                if (piece && piece.color === color) {
                    const validMoves = this.getValidMoves(row, col);
                    if (validMoves.length > 0) return false;
                }
            }
        }
        return true;
    }

    updateCapturedPieces() {
        const whiteElement = document.getElementById('capturedWhite');
        const blackElement = document.getElementById('capturedBlack');
        whiteElement.innerHTML = this.capturedPieces.white.map(piece => this.getPieceSymbol(piece)).join(' ');
        blackElement.innerHTML = this.capturedPieces.black.map(piece => this.getPieceSymbol(piece)).join(' ');
    }

    updateMoveHistory() {
        const movesList = document.getElementById('movesList');
        movesList.innerHTML = '';
        for (let i = 0; i < this.moveHistory.length; i += 2) {
            const moveNumber = Math.floor(i / 2) + 1;
            const whiteMove = this.moveHistory[i];
            const blackMove = this.moveHistory[i + 1];
            const numberElement = document.createElement('div');
            numberElement.className = 'move-number';
            numberElement.textContent = moveNumber + '.';
            movesList.appendChild(numberElement);
            const whiteElement = document.createElement('div');
            whiteElement.className = 'move-item white-move';
            whiteElement.textContent = whiteMove ? whiteMove.notation : '';
            movesList.appendChild(whiteElement);
            const blackElement = document.createElement('div');
            blackElement.className = 'move-item black-move';
            blackElement.textContent = blackMove ? blackMove.notation : '';
            movesList.appendChild(blackElement);
        }
        movesList.scrollTop = movesList.scrollHeight;
    }

    updateControlStates() {
        const btnNew = document.getElementById('btnNewGame');
        const btnMulti = document.getElementById('btnMultiplayer');
        const btnResign = document.getElementById('btnResign');
        const matchInProgress = (this.isMultiplayer && this.connected && !this.gameOver) || (!this.isMultiplayer && this.gameStarted && !this.gameOver);
        if (btnNew) btnNew.disabled = matchInProgress;
        if (btnMulti) btnMulti.disabled = matchInProgress;
        if (btnResign) btnResign.disabled = !matchInProgress;
    }
}

let game = new ChessGame();

// Bind timer controls once globally to the current game instance
(function bindTimerControlsOnce() {
    const enableTimer = document.getElementById('enableRightTimer');
    const timerSelect = document.getElementById('rightTimerSelect');
    if (enableTimer) {
        enableTimer.addEventListener('change', () => {
            if (!game) return;
            if (enableTimer.checked && game.gameStarted) {
                game.updateGameInfo('You cannot enable the timer after the game has started.');
                enableTimer.checked = false;
                game.timerEnabled = false;
                game.updateTimerDisplay();
                return;
            }
            game.stopTimer();
            game.setupTimer();
            if (game.timerEnabled && game.gameStarted && !game.timerInterval) {
                game.startTimer();
            }
        });
    }
    if (timerSelect) {
        timerSelect.addEventListener('change', () => {
            if (!game) return;
            const wasRunning = !!game.timerInterval;
            game.stopTimer();
            game.setupTimer();
            if (game.timerEnabled && (game.gameStarted || game.isMultiplayer) && wasRunning) {
                game.startTimer();
            }
        });
    }
})();

// Update your existing app.js with these modifications for random matchmaking

// Global variables for multiplayer (add these if not already present)
let stompClient = null;
let gameId = null;
let playerName = null;
let isConnected = false;
let waitingForOpponent = false;
let myColor = null;
let gameMode = 'local'; // 'local' or 'multiplayer'

// Function to join random game - REPLACE your existing joinRandomGame function


// Function to connect to WebSocket - UPDATE your existing function
function connectToWebSocket(callback) {
    // Use your existing backend URL - update this to match your WebSocket endpoint
    const socket = new SockJS('https://chess-backend-hu0h.onrender.com/chess-websocket');
    stompClient = Stomp.over(socket);
    
    // Disable debug logging
    stompClient.debug = null;
    
    const connectHeaders = {
        'playerName': playerName || 'Anonymous'
    };
    
    stompClient.connect(connectHeaders, function(frame) {
        console.log('Connected to WebSocket:', frame);
        isConnected = true;
        
        // Subscribe to match notifications
        stompClient.subscribe('/user/queue/match', function(message) {
            handleMatchMessage(JSON.parse(message.body));
        });
        
        // Subscribe to game updates if already in a game
        if (gameId) {
            stompClient.subscribe('/topic/game/' + gameId, function(gameMessage) {
                handleGameMessage(JSON.parse(gameMessage.body));
            });
        }
        
        if (callback) callback();
        
    }, function(error) {
        console.error('WebSocket connection failed:', error);
        isConnected = false;
        updateConnectionStatus('Connection failed');
        hideWaitingStatus();
        alert('Failed to connect to game server. Please check your internet connection and try again.');
    });
}

// Function to request random match
function requestRandomMatch() {
    if (stompClient && isConnected) {
        const matchRequest = {
            playerName: playerName,
            type: 'RANDOM_MATCH'
        };
        
        try {
            stompClient.send('/app/findRandomMatch', {}, JSON.stringify(matchRequest));
            waitingForOpponent = true;
            updateConnectionStatus('Searching for opponent...');
        } catch (error) {
            console.error('Error sending match request:', error);
            hideWaitingStatus();
            alert('Failed to start matchmaking. Please try again.');
        }
    }
}

// Handle match-related messages - UPDATE your existing function
function handleMatchMessage(message) {
    console.log('Match message received:', message);
    
    switch(message.type) {
        case 'MATCH_FOUND':
            handleMatchFound(message);
            break;
        case 'WAITING_FOR_OPPONENT':
            handleWaitingForOpponent(message);
            break;
        case 'MATCH_CANCELLED':
            handleMatchCancelled(message);
            break;
        case 'MATCH_TIMEOUT':
            handleMatchTimeout(message);
            break;
        case 'MATCH_ERROR':
            handleMatchError(message);
            break;
        default:
            console.log('Unknown match message type:', message.type);
    }
}

// Handle when a match is found
function handleMatchFound(message) {
    gameId = message.gameId;
    myColor = message.playerColor;
    waitingForOpponent = false;
    
    hideWaitingStatus();
    closeMultiplayerMenu();
    
    // Set up the game
    updateConnectionStatus(`Matched! Game ID: ${gameId}`);
    updateGameInfo(`Playing as ${message.playerColor} vs ${message.opponentName}`);
    
    // Subscribe to specific game updates
    stompClient.subscribe(`/topic/game/${gameId}`, function(gameMessage) {
        handleGameMessage(JSON.parse(gameMessage.body));
    });
    
    // Send join message to the game
    const joinMessage = {
        type: 'join',
        gameId: gameId,
        playerId: getSessionId(),
        playerName: playerName
    };
    
    stompClient.send(`/app/game/${gameId}/join`, {}, JSON.stringify(joinMessage));
    
    // Start the game
    startMultiplayerGame(message.playerColor, message.opponentName);
}

// Handle waiting for opponent
function handleWaitingForOpponent(message) {
    updateConnectionStatus('Waiting for opponent...');
    showWaitingStatus(message.message || 'Searching for an opponent...');
    
    // Update queue size if provided
    if (message.queueSize !== undefined) {
        updateWaitingMessage(`Searching for opponent... (${message.queueSize} players in queue)`);
    }
}

// Handle match cancellation
function handleMatchCancelled(message) {
    waitingForOpponent = false;
    hideWaitingStatus();
    updateConnectionStatus('Match search cancelled');
    
    if (message.message) {
        alert(message.message);
    }
}

// Handle match timeout
function handleMatchTimeout(message) {
    waitingForOpponent = false;
    hideWaitingStatus();
    updateConnectionStatus('Match search timed out');
    
    alert(message.message || 'No opponent found within the time limit. Please try again.');
}

// Handle match error
function handleMatchError(message) {
    waitingForOpponent = false;
    hideWaitingStatus();
    updateConnectionStatus('Match error');
    
    alert('Error: ' + (message.message || 'An error occurred during matchmaking'));
}

// Cancel random match search
function cancelRandomMatch() {
    if (stompClient && waitingForOpponent) {
        const cancelRequest = {
            playerName: playerName
        };
        
        stompClient.send('/app/cancelRandomMatch', {}, JSON.stringify(cancelRequest));
        waitingForOpponent = false;
        hideWaitingStatus();
        updateConnectionStatus('Match search cancelled');
    }
}

// Get session ID (you might need to implement this based on your session management)
function getSessionId() {
    // If you have a way to get the session ID, use it
    // Otherwise, you can use the WebSocket session or generate a unique ID
    if (stompClient && stompClient.ws) {
        return stompClient.ws._transport.url.split('/')[5]; // Extract session ID from SockJS URL
    }
    
    // Fallback: generate a unique ID if no session available
    return 'player-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Start multiplayer game - ADD this function if it doesn't exist
function startMultiplayerGame(playerColor, opponentName) {
    // Initialize game state for multiplayer
    currentPlayer = 'white';
    gameMode = 'multiplayer';
    myColor = playerColor;
    
    // Update UI
    document.getElementById('currentPlayer').textContent = 
        `${currentPlayer === myColor ? 'Your' : opponentName + "'s"} Turn`;
    
    // Enable/disable board interaction based on turn
    updateBoardInteraction();
    
    // Reset the game board if needed
    if (typeof initializeBoard === 'function') {
        initializeBoard();
    }
}

// Update board interaction based on turn - ADD this function if it doesn't exist
function updateBoardInteraction() {
    const board = document.getElementById('chessboard');
    if (gameMode === 'multiplayer') {
        if (currentPlayer === myColor) {
            board.classList.remove('disabled');
        } else {
            board.classList.add('disabled');
        }
    } else {
        board.classList.remove('disabled');
    }
}

// UI Helper functions - UPDATE these if they exist, ADD if they don't
function showWaitingStatus(message) {
    const modal = document.getElementById('multiplayerModal');
    const dialog = modal.querySelector('.multiplayer-dialog');
    
    let waitingDiv = document.getElementById('waitingStatus');
    if (!waitingDiv) {
        waitingDiv = document.createElement('div');
        waitingDiv.id = 'waitingStatus';
        waitingDiv.className = 'waiting-status';
        dialog.appendChild(waitingDiv);
    }
    
    waitingDiv.innerHTML = `
        <div class="waiting-spinner">⏳</div>
        <div class="waiting-message">${message}</div>
        <div class="waiting-timer" id="waitingTimer">Time elapsed: 0:00</div>
        <button class="btn btn-cancel" onclick="cancelRandomMatch()">Cancel Search</button>
    `;
    
    // Hide other options while waiting
    const options = dialog.querySelector('.multiplayer-options');
    options.style.display = 'none';
    waitingDiv.style.display = 'block';
    
    // Start timer
    startWaitingTimer();
}

function hideWaitingStatus() {
    const waitingDiv = document.getElementById('waitingStatus');
    if (waitingDiv) {
        waitingDiv.style.display = 'none';
    }
    
    // Stop timer
    stopWaitingTimer();
    
    const options = document.querySelector('.multiplayer-options');
    if (options) {
        options.style.display = 'block';
    }
}

function updateWaitingMessage(message) {
    const waitingMessage = document.querySelector('.waiting-message');
    if (waitingMessage) {
        waitingMessage.textContent = message;
    }
}

// Timer functions for waiting status
let waitingTimerInterval = null;
let waitingStartTime = null;

function startWaitingTimer() {
    waitingStartTime = Date.now();
    waitingTimerInterval = setInterval(updateWaitingTimer, 1000);
}

function stopWaitingTimer() {
    if (waitingTimerInterval) {
        clearInterval(waitingTimerInterval);
        waitingTimerInterval = null;
        waitingStartTime = null;
    }
}

function updateWaitingTimer() {
    if (!waitingStartTime) return;
    
    const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    const timerElement = document.getElementById('waitingTimer');
    if (timerElement) {
        timerElement.textContent = `Time elapsed: ${timeString}`;
    }
}

function updateConnectionStatus(status) {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
}

function updateGameInfo(info) {
    const infoElement = document.getElementById('gameInfoPanel');
    if (infoElement) {
        infoElement.textContent = info;
    }
}

// Handle game messages during play - UPDATE your existing function if it exists
function handleGameMessage(message) {
    console.log('Game message received:', message);
    
    switch(message.type) {
        case 'move':
            handleOpponentMove(message);
            break;
        case 'gameJoined':
        case 'playerJoined':
            handlePlayerJoined(message);
            break;
        case 'gameStart':
            handleGameStart(message);
            break;
        case 'gameEnd':
            handleGameEnd(message);
            break;
        case 'resign':
            handlePlayerResign(message);
            break;
        case 'drawOffer':
            handleDrawOffer(message);
            break;
        case 'drawAccept':
            handleDrawAccept(message);
            break;
        case 'drawDecline':
            handleDrawDecline(message);
            break;
        case 'playerDisconnected':
            handlePlayerDisconnected(message);
            break;
        case 'error':
            handleGameError(message);
            break;
        default:
            console.log('Unknown game message:', message);
    }
}

// Handle opponent's move - ADD this function
function handleOpponentMove(message) {
    if (!message.move) return;
    
    const move = message.move;
    console.log('Opponent move:', move);
    
    // Apply the move to the board (you'll need to implement this based on your board logic)
    if (typeof applyMoveToBoard === 'function') {
        applyMoveToBoard(move);
    }
    
    // Switch turns
    currentPlayer = currentPlayer === 'white' ? 'black' : 'white';
    updateCurrentPlayerDisplay();
    updateBoardInteraction();
    
    // Add to move history if you have that functionality
    if (typeof addMoveToHistory === 'function') {
        addMoveToHistory(move.fromRow, move.fromCol, move.toRow, move.toCol, move.piece);
    }
}

function handlePlayerJoined(message) {
    console.log('Player joined:', message);
    if (message.gameState && message.gameState.isGameFull) {
        updateGameInfo(`Game ready - both players connected`);
    }
}

function handleGameStart(message) {
    console.log('Game started:', message);
    updateConnectionStatus('Game Active');
    updateGameInfo(`Game started! You are playing as ${myColor}`);
}

function handleGameEnd(message) {
    console.log('Game ended:', message);
    const gameState = message.gameState;
    
    if (gameState && gameState.winner) {
        let endMessage = '';
        if (gameState.winner === 'draw') {
            endMessage = 'Game ended in a draw';
        } else if (gameState.winner === myColor) {
            endMessage = 'You won!';
        } else {
            endMessage = 'You lost';
        }
        
        updateGameInfo(endMessage);
        alert(endMessage);
    }
    
    // Reset game mode to local
    gameMode = 'local';
    gameId = null;
    myColor = null;
}

function handlePlayerResign(message) {
    const resignedPlayerName = message.playerName;
    if (message.playerId !== getSessionId()) {
        alert(`${resignedPlayerName} resigned. You won!`);
    }
}

function handleDrawOffer(message) {
    if (message.playerId !== getSessionId()) {
        const accept = confirm(`${message.playerName} offered a draw. Do you accept?`);
        if (accept) {
            acceptDraw();
        } else {
            declineDraw();
        }
    }
}

function handleDrawAccept(message) {
    if (message.playerId !== getSessionId()) {
        alert(`${message.playerName} accepted the draw offer. Game ended in a draw.`);
    }
}

function handleDrawDecline(message) {
    if (message.playerId !== getSessionId()) {
        alert(`${message.playerName} declined the draw offer. Game continues.`);
    }
}

function handlePlayerDisconnected(message) {
    updateGameInfo(`${message.playerName} disconnected`);
    alert(`${message.playerName} disconnected from the game.`);
}

function handleGameError(message) {
    console.error('Game error:', message.error);
    alert('Game error: ' + message.error);
}

// Game action functions - ADD these for multiplayer functionality
function sendMove(fromRow, fromCol, toRow, toCol, piece, capturedPiece) {
    if (gameMode === 'multiplayer' && stompClient && gameId) {
        const move = {
            fromRow: fromRow,
            fromCol: fromCol,
            toRow: toRow,
            toCol: toCol,
            piece: piece,
            capturedPiece: capturedPiece
        };
        
        const moveMessage = {
            type: 'move',
            gameId: gameId,
            playerId: getSessionId(),
            playerName: playerName,
            move: move
        };
        
        stompClient.send(`/app/game/${gameId}/move`, {}, JSON.stringify(moveMessage));
    }
}

function resignGame() {
    if (gameMode === 'multiplayer' && stompClient && gameId) {
        const resignMessage = {
            type: 'resign',
            gameId: gameId,
            playerId: getSessionId(),
            playerName: playerName
        };
        
        stompClient.send(`/app/game/${gameId}/resign`, {}, JSON.stringify(resignMessage));
    } else {
        // Local game resign logic
        if (confirm('Are you sure you want to resign?')) {
            alert('You resigned the game.');
            if (typeof resetGame === 'function') {
                resetGame();
            }
        }
    }
}

function offerDraw() {
    if (gameMode === 'multiplayer' && stompClient && gameId) {
        const drawMessage = {
            type: 'drawOffer',
            gameId: gameId,
            playerId: getSessionId(),
            playerName: playerName
        };
        
        stompClient.send(`/app/game/${gameId}/draw-offer`, {}, JSON.stringify(drawMessage));
        alert('Draw offer sent to opponent.');
    }
}

function acceptDraw() {
    if (gameMode === 'multiplayer' && stompClient && gameId) {
        const acceptMessage = {
            type: 'drawAccept',
            gameId: gameId,
            playerId: getSessionId(),
            playerName: playerName
        };
        
        stompClient.send(`/app/game/${gameId}/draw-accept`, {}, JSON.stringify(acceptMessage));
    }
}

function declineDraw() {
    if (gameMode === 'multiplayer' && stompClient && gameId) {
        const declineMessage = {
            type: 'drawDecline',
            gameId: gameId,
            playerId: getSessionId(),
            playerName: playerName
        };
        
        stompClient.send(`/app/game/${gameId}/draw-decline`, {}, JSON.stringify(declineMessage));
    }
}

// Disconnect from multiplayer - UPDATE your existing function
function disconnectMultiplayer() {
    if (stompClient && isConnected) {
        if (gameId) {
            const disconnectMessage = {
                type: 'disconnect',
                gameId: gameId,
                playerId: getSessionId(),
                playerName: playerName
            };
            
            stompClient.send(`/app/game/${gameId}/disconnect`, {}, JSON.stringify(disconnectMessage));
        }
        
        // Cancel any pending match search
        if (waitingForOpponent) {
            cancelRandomMatch();
        }
        
        stompClient.disconnect();
        stompClient = null;
        isConnected = false;
        gameId = null;
        myColor = null;
        waitingForOpponent = false;
        gameMode = 'local';
        
        updateConnectionStatus('Local Game Mode');
        updateGameInfo('');
        hideWaitingStatus();
    }
}

// Handle page unload to clean up connections
window.addEventListener('beforeunload', function() {
    if (waitingForOpponent) {
        cancelRandomMatch();
    }
    disconnectMultiplayer();
});

function resetGame() {
    if (game.isMultiplayer) game.resetToLocal();
    const timerControls = document.querySelector('.timer-controls');
    if (timerControls) timerControls.style.display = 'flex';
    game = new ChessGame();
}

function showMultiplayerMenu() {
    document.getElementById('multiplayerModal').style.display = 'flex';
    document.getElementById('playerNameInput').focus();
}

function closeMultiplayerMenu() {
    document.getElementById('multiplayerModal').style.display = 'none';
    document.getElementById('joinGameSection').style.display = 'none';
}

function showJoinGameDialog() {
    document.getElementById('joinGameSection').style.display = 'block';
    document.getElementById('gameIdInput').focus();
}

async function createMultiplayerGame() { await game.createMultiplayerGame(); }
async function joinRandomGame() { await game.joinRandomGame(); }
async function joinSpecificGame() { await game.joinSpecificGame(); }
function resignGame() { game.resign(); }
function offerDraw() { game.offerDraw(); }

window.addEventListener('beforeunload', () => {
    if (game.stompClient && game.connected) game.disconnectFromServer();
});


