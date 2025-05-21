require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const dns = require("dns");
const crypto = require("crypto");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Estructura para almacenar las salas
const rooms = new Map();
// Registro de IPs conectadas con sus sockets asociados
const connectedIPs = new Map();

// Función para generar un código único para la sala
function generateRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

io.on("connection", (socket) => {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const clientIp = forwarded
  ? forwarded.split(',')[0].trim().replace("::ffff:", "")
  : socket.handshake.address.replace("::ffff:", "");

  console.log(`Client connected: ${clientIp}`);
  dns.reverse(socket.handshake.address, (err, hostnames) => {
    const hostname = err ? clientIp : hostnames[0];
    console.log(`Client hostname: ${hostname}`);
    socket.emit("host_info", { ip: clientIp, host: hostname });
  });

  console.log("IP CLIENTE", clientIp);
  console.log("ip conectadas", connectedIPs);
  // Verificar si la IP ya está conectada
  if (connectedIPs.has(clientIp)) {
    socket.emit("connection_rejected", {
      message: "Ya estás conectado desde otro navegador.",
    });
    socket.disconnect();
    return;
  }

  // Registrar la conexión de esta IP
  connectedIPs.set(clientIp, socket.id);
  socket.data.ip = clientIp;

  // Enviar lista de salas disponibles al cliente que se conecta
  const availableRooms = [];
  rooms.forEach((roomData, roomCode) => {
    if (roomData.users.size < roomData.maxUsers) {
      availableRooms.push({
        code: roomCode,
        name: roomData.name,
        userCount: roomData.users.size,
        maxUsers: roomData.maxUsers,
      });
    }
  });
  socket.emit("available_rooms", availableRooms);

  // Crear una nueva sala
  socket.on("create_room", ({ roomName, maxUsers }) => {
    const roomCode = generateRoomCode();

    // Crear la sala con la estructura necesaria
    rooms.set(roomCode, {
      name: roomName,
      maxUsers: maxUsers || 10, // Por defecto 10 usuarios máximo
      users: new Map(),
      messages: [],
    });

    console.log(`Room created: ${roomName} with code ${roomCode}`);
    socket.emit("room_created", { roomCode });

    // Actualizar la lista de salas disponibles para todos
    io.emit("room_list_updated");
  }); // Unirse a una sala
  socket.on("join_room", ({ roomCode, username }) => {
    console.log(
      `Intento de unirse a la sala ${roomCode} por usuario ${username}`
    );

    // Comprobar si la sala existe
    if (!rooms.has(roomCode)) {
      console.log(`Error: La sala ${roomCode} no existe`);
      socket.emit("join_room_error", { message: "La sala no existe." });
      return;
    }

    const room = rooms.get(roomCode);

    // Comprobar si la sala está llena
    if (room.users.size >= room.maxUsers) {
      console.log(`Error: La sala ${roomCode} está llena`);
      socket.emit("join_room_error", { message: "La sala está llena." });
      return;
    }

    // Almacenar datos del usuario en la sala
    socket.data.currentRoom = roomCode;
    socket.data.username = username;

    // Añadir usuario a la sala
    room.users.set(socket.id, { username, id: socket.id });

    // Unir el socket a la sala
    socket.join(roomCode);

    // Notificar a la sala que un nuevo usuario se ha unido
    io.to(roomCode).emit("user_joined", {
      user: { username, id: socket.id },
      userCount: room.users.size,
    });

    // Enviar historial de mensajes de la sala al usuario
    socket.emit("room_history", {
      messages: room.messages,
      users: Array.from(room.users.values()),
    });

    console.log(`User ${username} joined room ${roomCode}`);
  }); // Enviar mensaje a la sala
  socket.on("send_message", (msg) => {
    const roomCode = socket.data.currentRoom;

    // Comprobar si el usuario está en una sala
    if (!roomCode || !rooms.has(roomCode)) {
      console.log(
        `Error: Usuario ${socket.data.username} intenta enviar mensaje pero no está en una sala válida.`
      );
      socket.emit("message_error", { message: "No estás en una sala válida." });
      return;
    }

    const room = rooms.get(roomCode);
    const messageData = {
      id: Date.now().toString(),
      text: msg.text,
      username: socket.data.username,
      timestamp: new Date().toISOString(),
    };

    console.log(
      `Mensaje recibido de ${socket.data.username} en sala ${roomCode}: ${msg.text}`
    );

    // Almacenar el mensaje en el historial de la sala
    room.messages.push(messageData);

    // Limitar el historial a los últimos 100 mensajes para no sobrecargar la memoria
    if (room.messages.length > 100) {
      room.messages.shift();
    }

    // Enviar el mensaje a todos los usuarios en la sala
    io.to(roomCode).emit("receive_message", messageData);
  }); // Salir de una sala
  socket.on("leave_room", () => {
    const roomCode = socket.data.currentRoom;
    console.log(
      `Intento de salir de sala por usuario ${socket.data.username} de la sala ${roomCode}`
    );

    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);

      // Eliminar al usuario de la sala
      room.users.delete(socket.id);

      // Notificar a los demás usuarios que alguien ha salido
      io.to(roomCode).emit("user_left", {
        userId: socket.id,
        username: socket.data.username,
        userCount: room.users.size,
      });

      console.log(
        `Usuario ${socket.data.username} ha salido de la sala ${roomCode}. Quedan ${room.users.size} usuarios`
      );

      // Comprobar si la sala está vacía para eliminarla
      if (room.users.size === 0) {
        rooms.delete(roomCode);
        io.emit("room_list_updated");
        console.log(`Room ${roomCode} has been removed as it's empty.`);
      }

      // Quitar al socket de la sala
      socket.leave(roomCode);
      socket.data.currentRoom = null;
    } else {
      console.log(
        `Usuario ${socket.data.username} intentó salir pero no está en ninguna sala o la sala no existe`
      );
    }
  });

  // Enviar lista actualizada de salas
  socket.on("get_rooms", () => {
    const availableRooms = [];
    rooms.forEach((roomData, roomCode) => {
      if (roomData.users.size < roomData.maxUsers) {
        availableRooms.push({
          code: roomCode,
          name: roomData.name,
          userCount: roomData.users.size,
          maxUsers: roomData.maxUsers,
        });
      }
    });
    socket.emit("available_rooms", availableRooms);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${clientIp}`);

    // Eliminar la IP del registro de conexiones
    if (connectedIPs.get(clientIp) === socket.id) {
      connectedIPs.delete(clientIp);
    }

    // Si el usuario estaba en una sala, eliminarlo de ella
    const roomCode = socket.data.currentRoom;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);

      // Eliminar al usuario de la sala
      room.users.delete(socket.id);

      // Notificar a los demás usuarios
      io.to(roomCode).emit("user_left", {
        userId: socket.id,
        username: socket.data.username,
        userCount: room.users.size,
      });

      // Si la sala queda vacía, eliminarla
      if (room.users.size === 0) {
        rooms.delete(roomCode);
        io.emit("room_list_updated");
        console.log(`Room ${roomCode} has been removed as it's empty.`);
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
