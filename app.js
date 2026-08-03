// ============================================
// CONFIGURAZIONE FIREBASE
// Sostituisci i valori sotto con quelli del TUO progetto Firebase:
// 1. Vai su https://console.firebase.google.com -> Crea un progetto
// 2. Build > Realtime Database -> Crea database (parti in modalità test)
// 3. Project settings (icona ingranaggio) > Le tue app > Aggiungi app Web
// 4. Copia i valori generati qui sotto
// ============================================
const firebaseConfig = {
  apiKey: "AIzaSyD6VaXsSNnf47y7hNce1djJxLDWqZOCEdQ",
  authDomain: "chatx60-230f9.firebaseapp.com",
  databaseURL: "https://chatx60-230f9-default-rtdb.firebaseio.com",
  projectId: "chatx60-230f9",
  storageBucket: "chatx60-230f9.firebasestorage.app",
  messagingSenderId: "210275544363",
  appId: "1:210275544363:web:d2ecd4f4a37fb52a55296e"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const PUBLIC_ROOM = { id: "generale", name: "Stanza Generale" };
const MESSAGE_TTL_MS = 12 * 60 * 60 * 1000; // i messaggi vengono eliminati dopo 12 ore
const PRESENCE_TTL_MS = 60 * 1000; // un utente è considerato "online" se visto negli ultimi 60s

let currentUsername = "";
let currentUserKey = "";
let activeRoomId = PUBLIC_ROOM.id;
let activeRoomName = PUBLIC_ROOM.name;
let activeRoomRef = null; // riferimento Firebase con listener attivo (per poterlo staccare)
let presenceInterval = null;
let cleanupInterval = null;
let onlineUsersRef = null;
let myDmRoomsRef = null;
let dmRoomsCache = [];
let unreadListenerRefs = {};
let unreadRoomIds = new Set();
let cameraStream = null;
let currentFacingMode = "user";
let currentBase64Image = "";

// REGISTRAZIONE SERVICE WORKER (necessaria per l'installazione PWA vera)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .catch((err) => console.error("Registrazione Service Worker fallita:", err));
  });
}

window.addEventListener("beforeunload", () => {
  if (currentUserKey) {
    db.ref(`presence/${currentUserKey}`).remove();
  }
});

// AVVIO APP
window.addEventListener("DOMContentLoaded", () => {
  renderRoomsList();

  const savedUser = sessionStorage.getItem("converso_user");
  if (savedUser) {
    currentUsername = savedUser;
    document.getElementById("myUsernameDisplay").innerText = currentUsername;
    document.getElementById("welcomeModal").style.display = "none";
    startPresence();
  } else {
    document.getElementById("welcomeModal").style.display = "flex";
  }

  closeCamera();
});

function saveUsernameFromModal() {
  const input = document.getElementById("modalUsernameInput");
  const val = input.value.trim();
  if (val) {
    currentUsername = val;
    sessionStorage.setItem("converso_user", currentUsername);
    document.getElementById("myUsernameDisplay").innerText = currentUsername;
    document.getElementById("welcomeModal").style.display = "none";
    startPresence();
    // Sblocco l'audio qui: è la prima interazione certa dell'utente con la pagina
    if (!notifAudioCtx) {
      notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }
}

function logoutUser() {
  stopPresence();
  sessionStorage.removeItem("converso_user");
  location.reload();
}

// ============================================
// UTILITY DI SICUREZZA (escape contro HTML injection)
// ============================================
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ============================================
// PRESENZA UTENTI — necessaria per sapere chi è online per i Messaggi Privati
// ============================================
function startPresence() {
  currentUserKey = roomNameToId(currentUsername) || "utente";
  const myPresenceRef = db.ref(`presence/${currentUserKey}`);

  const updatePresence = () => {
    myPresenceRef.set({
      name: currentUsername,
      lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
  };

  updatePresence();
  myPresenceRef.onDisconnect().remove();
  presenceInterval = setInterval(updatePresence, 20000);

  cleanupInterval = setInterval(sweepOldMessagesInActiveRoom, 5 * 60 * 1000);

  // Ascolto le chat private che qualcuno ha avviato con me, così mi compaiono
  // in sidebar da sole, senza dover aprire io stesso "Messaggi Privati"
  myDmRoomsRef = db.ref(`userRooms/${currentUserKey}`);
  myDmRoomsRef.on("value", (snapshot) => {
    dmRoomsCache = [];
    snapshot.forEach((child) => {
      const data = child.val();
      if (data && data.name) {
        dmRoomsCache.push({ id: child.key, name: data.name });
      }
    });
    renderRoomsList();
  });
}

function stopPresence() {
  if (presenceInterval) clearInterval(presenceInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  if (myDmRoomsRef) myDmRoomsRef.off();
  if (currentUserKey) {
    db.ref(`presence/${currentUserKey}`).remove();
  }
}

// ============================================
// MESSAGGI PRIVATI (DM) — chat 1 a 1 tra due utenti
// ============================================
function dmRoomId(userA, userB) {
  const keys = [roomNameToId(userA), roomNameToId(userB)].sort();
  return `dm-${keys[0]}-${keys[1]}`;
}

function openDmModal() {
  document.getElementById("dmModal").style.display = "flex";
  db.ref("presence").once("value").then(renderOnlineUsersList);
  onlineUsersRef = db.ref("presence");
  onlineUsersRef.on("value", renderOnlineUsersList);
}

function closeDmModal() {
  document.getElementById("dmModal").style.display = "none";
  if (onlineUsersRef) {
    onlineUsersRef.off();
    onlineUsersRef = null;
  }
}

function renderOnlineUsersList(snapshot) {
  const container = document.getElementById("onlineUsersList");
  const now = Date.now();
  const users = [];
  snapshot.forEach((child) => {
    const data = child.val();
    if (child.key !== currentUserKey && data && data.lastSeen && (now - data.lastSeen) < PRESENCE_TTL_MS + 25000) {
      users.push({ key: child.key, name: data.name });
    }
  });

  if (users.length === 0) {
    container.innerHTML = '<p class="dm-empty-hint">Nessun altro utente online al momento.</p>';
    return;
  }

  container.innerHTML = users.map(u => `
    <div class="online-user-item" onclick="startDm('${escapeAttr(u.name)}')">
      <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(u.name)}" alt="${escapeHtml(u.name)}">
      <span class="online-user-name">${escapeHtml(u.name)}</span>
    </div>
  `).join("");
}

function escapeAttr(str) {
  return String(str).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function startDm(otherUsername) {
  const roomId = dmRoomId(currentUsername, otherUsername);
  const otherKey = roomNameToId(otherUsername);

  // Registro la stanza sia per me che per l'altra persona: così le compare
  // in automatico in sidebar, senza che debba cercarmi lei stessa
  db.ref(`userRooms/${currentUserKey}/${roomId}`).set({ name: otherUsername });
  db.ref(`userRooms/${otherKey}/${roomId}`).set({ name: currentUsername });

  closeDmModal();
  selectRoom(roomId);
}

// ============================================
// SUONO DI NOTIFICA — generato al volo, nessun file audio necessario
// ============================================
let notifAudioCtx = null;

function playNotificationSound() {
  try {
    if (!notifAudioCtx) {
      notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (notifAudioCtx.state === "suspended") {
      notifAudioCtx.resume();
    }
    const osc = notifAudioCtx.createOscillator();
    const gain = notifAudioCtx.createGain();
    osc.connect(gain);
    gain.connect(notifAudioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, notifAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.25, notifAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, notifAudioCtx.currentTime + 0.35);
    osc.start();
    osc.stop(notifAudioCtx.currentTime + 0.35);
  } catch (e) {
    console.error("Suono di notifica non disponibile:", e);
  }
}

// ============================================
// NOTIFICHE IN-APP — pallino rosso per messaggi non letti
// (funziona solo con l'app aperta, non è una vera notifica push)
// ============================================
function getLastSeenMap() {
  return JSON.parse(localStorage.getItem("converso_lastSeen") || "{}");
}

function getLastSeen(roomId) {
  return getLastSeenMap()[roomId] || 0;
}

function setLastSeen(roomId, ts) {
  const map = getLastSeenMap();
  map[roomId] = ts;
  localStorage.setItem("converso_lastSeen", JSON.stringify(map));
}

function ensureUnreadListener(roomId) {
  if (unreadListenerRefs[roomId]) return;
  const ref = db.ref(`rooms/${roomId}/messages`).limitToLast(1);
  unreadListenerRefs[roomId] = ref;
  let firstFire = true;

  ref.on("value", (snapshot) => {
    let lastMsg = null;
    snapshot.forEach((child) => { lastMsg = child.val(); });
    if (!lastMsg || !lastMsg.timestamp) {
      firstFire = false;
      return;
    }

    const seenUntil = getLastSeen(roomId);
    const isFromOther = lastMsg.sender !== currentUsername;
    const isNew = lastMsg.timestamp > seenUntil;
    const isCurrentlyOpen = roomId === activeRoomId;

    if (isFromOther && isNew && !isCurrentlyOpen) {
      unreadRoomIds.add(roomId);
      renderRoomsList();
      // Il suono suona solo per messaggi arrivati davvero ora,
      // non per quelli già esistenti al primo caricamento della lista
      if (!firstFire) playNotificationSound();
    }
    firstFire = false;
  });
}

// ============================================
// GESTIONE STANZE — Pubblica + Private (elenco locale per utente)
// ============================================
function getMyRooms() {
  return JSON.parse(localStorage.getItem("converso_myRooms") || "[]");
}

function saveMyRooms(rooms) {
  localStorage.setItem("converso_myRooms", JSON.stringify(rooms));
}

function addRoomToMyList(roomId, name) {
  const rooms = getMyRooms();
  if (!rooms.find(r => r.id === roomId)) {
    rooms.push({ id: roomId, name: name });
    saveMyRooms(rooms);
  }
}

function renderRoomsList() {
  const contactList = document.getElementById("contactList");
  const allRooms = [PUBLIC_ROOM, ...getMyRooms(), ...dmRoomsCache];

  allRooms.forEach(room => ensureUnreadListener(room.id));

  contactList.innerHTML = allRooms.map(room => {
    const safeName = escapeHtml(room.name);
    const seed = encodeURIComponent(room.name);
    const isActive = activeRoomId === room.id ? "active" : "";
    const isDm = room.id.startsWith("dm-");
    const subtitle = room.id === PUBLIC_ROOM.id ? "Stanza pubblica" : (isDm ? "Messaggio privato" : "Stanza privata");
    const unreadDot = unreadRoomIds.has(room.id) ? '<span class="unread-dot"></span>' : '';
    return `
      <div class="contact-item ${isActive}" onclick="selectRoom('${room.id}')">
        <div class="avatar">
          <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${seed}" alt="${safeName}">
          <span class="status-dot"></span>
        </div>
        <div class="contact-info">
          <div class="contact-name">${safeName}${unreadDot}</div>
          <div class="contact-preview">${subtitle}</div>
        </div>
      </div>
    `;
  }).join("");
}

function findRoomById(roomId) {
  return [PUBLIC_ROOM, ...getMyRooms(), ...dmRoomsCache].find(r => r.id === roomId);
}

function selectRoom(roomId) {
  const room = findRoomById(roomId);
  if (!room) return;

  activeRoomId = room.id;
  activeRoomName = room.name;

  setLastSeen(roomId, Date.now());
  unreadRoomIds.delete(roomId);

  document.getElementById("chatName").innerText = room.name;
  document.getElementById("chatAvatarImg").src = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(room.name)}`;

  document.getElementById("emptyState").style.display = "none";
  document.getElementById("chatActive").style.display = "flex";
  document.body.classList.add("chat-open");

  renderRoomsList();
  listenToMessages(room.id);
}

function goBack() {
  document.body.classList.remove("chat-open");
}

// ============================================
// GESTIONE MESSAGGI — Firebase Realtime Database
// ============================================
function listenToMessages(roomId) {
  // Stacca il listener sulla stanza precedente per non tenere ascolti multipli attivi
  if (activeRoomRef) {
    activeRoomRef.off();
  }

  const messagesList = document.getElementById("messagesList");
  messagesList.innerHTML = "";

  activeRoomRef = db.ref(`rooms/${roomId}/messages`).orderByChild("timestamp");

  activeRoomRef.on("value", (snapshot) => {
    messagesList.innerHTML = "";
    const now = Date.now();
    snapshot.forEach((child) => {
      const msg = child.val();
      // Ignora (e rimuove) i messaggi più vecchi di 12 ore
      if (msg.timestamp && (now - msg.timestamp) > MESSAGE_TTL_MS) {
        db.ref(`rooms/${roomId}/messages/${child.key}`).remove();
        return;
      }
      appendMessageToDOM(msg, roomId, child.key);
    });
    const container = document.getElementById("messagesContainer");
    container.scrollTop = container.scrollHeight;
  });
}

function sweepOldMessagesInActiveRoom() {
  if (!activeRoomId) return;
  const now = Date.now();
  db.ref(`rooms/${activeRoomId}/messages`).once("value").then((snapshot) => {
    snapshot.forEach((child) => {
      const msg = child.val();
      if (msg.timestamp && (now - msg.timestamp) > MESSAGE_TTL_MS) {
        db.ref(`rooms/${activeRoomId}/messages/${child.key}`).remove();
      }
    });
  });
}

function deleteMessage(roomId, key) {
  if (!confirm("Eliminare questo messaggio per tutti?")) return;
  db.ref(`rooms/${roomId}/messages/${key}`).remove()
    .catch((err) => alert("Errore nell'eliminazione: " + err.message));
}

function appendMessageToDOM(msg, roomId, key) {
  const messagesList = document.getElementById("messagesList");
  const isMe = msg.sender === currentUsername;
  const senderName = msg.sender || "Anonimo";

  const row = document.createElement("div");
  row.className = `msg-row ${isMe ? 'row-sent' : 'row-received'}`;

  const avatar = document.createElement("img");
  avatar.className = "msg-avatar";
  avatar.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(senderName)}`;
  avatar.alt = escapeHtml(senderName);

  const div = document.createElement("div");
  div.className = `message ${isMe ? 'msg-sent' : 'msg-received'}`;

  let content = `<div class="msg-sender">${escapeHtml(senderName)}</div>`;
  if (isMe) {
    content += `<button class="msg-delete-btn" onclick="deleteMessage('${roomId}','${key}')" title="Elimina messaggio"><i class="fa-solid fa-trash"></i></button>`;
  }
  if (msg.text) content += `<div>${escapeHtml(msg.text)}</div>`;
  if (msg.image) content += `<img src="${msg.image}" class="msg-image" onclick="window.open('${msg.image}')">`;
  content += `<div class="msg-meta">${escapeHtml(msg.time || '')}</div>`;

  div.innerHTML = content;
  row.appendChild(avatar);
  row.appendChild(div);
  messagesList.appendChild(row);
}

function sendMessage() {
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text && !currentBase64Image) return;

  const now = new Date();
  const timeStr = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');

  const newMessage = {
    sender: currentUsername || "Anonimo",
    text: text,
    image: currentBase64Image || null,
    time: timeStr,
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };

  db.ref(`rooms/${activeRoomId}/messages`).push(newMessage)
    .catch((err) => alert("Errore nell'invio del messaggio: " + err.message));

  input.value = "";
  autoResize(input);
  clearMediaPreview();
  toggleSendBtn();
}

function handleKeyDown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function toggleSendBtn() {
  const val = document.getElementById("msgInput").value.trim();
  document.getElementById("sendBtn").disabled = (!val && !currentBase64Image);
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ============================================
// STANZE PRIVATE — creazione e accesso con PIN
// ============================================
function openPrivateModal() {
  document.getElementById("privateRoomModal").style.display = "flex";
  document.getElementById("createRoomForm").style.display = "none";
  document.getElementById("joinRoomForm").style.display = "none";
}

function closePrivateModal() {
  document.getElementById("privateRoomModal").style.display = "none";
  document.getElementById("newRoomName").value = "";
  document.getElementById("newRoomPin").value = "";
  document.getElementById("joinRoomName").value = "";
  document.getElementById("joinRoomPin").value = "";
}

function showCreateRoomForm() {
  document.getElementById("createRoomForm").style.display = "block";
  document.getElementById("joinRoomForm").style.display = "none";
}

function showJoinRoomForm() {
  document.getElementById("joinRoomForm").style.display = "block";
  document.getElementById("createRoomForm").style.display = "none";
}

function roomNameToId(name) {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

function submitCreateRoom() {
  const name = document.getElementById("newRoomName").value.trim();
  const pin = document.getElementById("newRoomPin").value.trim();

  if (!name || !pin) {
    alert("Inserisci nome stanza e PIN.");
    return;
  }

  const roomId = roomNameToId(name);
  if (!roomId || roomId === PUBLIC_ROOM.id) {
    alert("Nome stanza non valido, scegline un altro.");
    return;
  }

  const metaRef = db.ref(`rooms/${roomId}/meta`);
  metaRef.once("value").then((snapshot) => {
    if (snapshot.exists()) {
      alert("Esiste già una stanza con questo nome. Usa 'Entra in una Stanza' oppure scegli un altro nome.");
      return;
    }
    return metaRef.set({
      name: name,
      pin: pin,
      createdAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      addRoomToMyList(roomId, name);
      closePrivateModal();
      selectRoom(roomId);
    });
  }).catch((err) => {
    alert("Errore nella creazione della stanza: " + err.message);
  });
}

function submitJoinRoom() {
  const name = document.getElementById("joinRoomName").value.trim();
  const pin = document.getElementById("joinRoomPin").value.trim();

  if (!name || !pin) {
    alert("Inserisci nome stanza e PIN.");
    return;
  }

  const roomId = roomNameToId(name);
  const metaRef = db.ref(`rooms/${roomId}/meta`);
  metaRef.once("value").then((snapshot) => {
    if (!snapshot.exists()) {
      alert("Nessuna stanza trovata con questo nome.");
      return;
    }
    const meta = snapshot.val();
    if (String(meta.pin) !== pin) {
      alert("PIN errato.");
      return;
    }
    addRoomToMyList(roomId, meta.name);
    closePrivateModal();
    selectRoom(roomId);
  }).catch((err) => {
    alert("Errore nell'accesso alla stanza: " + err.message);
  });
}

// ============================================
// FOTOCAMERA
// ============================================
async function openCamera() {
  const overlay = document.getElementById("cameraOverlay");
  overlay.style.setProperty("display", "flex", "important");
  overlay.classList.add("open");

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false
    });
    document.getElementById("cameraVideo").srcObject = cameraStream;
  } catch (err) {
    alert("Impossibile accedere alla fotocamera.");
    closeCamera();
  }
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  const overlay = document.getElementById("cameraOverlay");
  overlay.classList.remove("open");
  overlay.style.setProperty("display", "none", "important");
}

async function switchCamera() {
  currentFacingMode = (currentFacingMode === "user") ? "environment" : "user";
  closeCamera();
  openCamera();
}

function capturePhoto() {
  const video = document.getElementById("cameraVideo");
  const canvas = document.getElementById("cameraCanvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);

  currentBase64Image = canvas.toDataURL("image/jpeg", 0.6);
  document.getElementById("previewImg").src = currentBase64Image;
  document.getElementById("imagePreviewBar").classList.add("visible");
  toggleSendBtn();
  closeCamera();
}

// ============================================
// ALLEGATI GALLERIA
// ============================================
function triggerFileSelect() {
  document.getElementById("galleryInput").click();
}

function handleGalleryFiles(files) {
  if (files && files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      currentBase64Image = e.target.result;
      document.getElementById("previewImg").src = currentBase64Image;
      document.getElementById("imagePreviewBar").classList.add("visible");
      toggleSendBtn();
    };
    reader.readAsDataURL(files[0]);
  }
}

function clearMediaPreview() {
  currentBase64Image = "";
  document.getElementById("previewImg").src = "";
  document.getElementById("imagePreviewBar").classList.remove("visible");
  toggleSendBtn();
}
