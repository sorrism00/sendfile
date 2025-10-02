// ====== 설정 영역 ==========================================================
// Railway 시그널링 서버의 실제 URL로 변경해야 합니다.
// 예: 'wss://your-sendfile-signaling-server-abcd.up.railway.app'
const RAILWAY_SIGNALING_SERVER_URL = 'wss://sendfile-signaling-server-production.up.railway.app'; 
const STUN_SERVER_URL = 'stun:stun.l.google.com:19302';
const CHUNK_SIZE = 16 * 1024; // 16KB (WebRTC DataChannel 권장 청크 크기)
// ===========================================================================


// ====== DOM 요소 캐싱 ======================================================
const connectBtn = document.getElementById('connectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const fileInput = document.getElementById('fileInput');
const sendFileBtn = document.getElementById('sendFileBtn');
const sendFileStatus = document.getElementById('sendFileStatus');
const receiveStatus = document.getElementById('receiveStatus');
const receivedFilesList = document.getElementById('receivedFilesList');
// ===========================================================================


// ====== WebRTC 관련 변수 ===================================================
let ws; // WebSocket 연결
let peerConnection; // RTCPeerConnection 객체
let sendChannel; // 파일 송신용 DataChannel
let receiveChannel; // 파일 수신용 DataChannel

let receivedFileBuffers = []; // 수신된 파일 청크들을 저장할 배열
let receivedMetadata = null; // 수신된 파일의 메타데이터 (이름, 크기 등)
let receivedSize = 0; // 현재까지 수신된 파일 크기
// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    // WebSocket 연결 시작
    connectWebSocket();

    connectBtn.addEventListener('click', createPeerConnectionAndOffer);
    fileInput.addEventListener('change', () => {
        sendFileBtn.disabled = fileInput.files.length === 0 || peerConnection.connectionState !== 'connected';
    });
    sendFileBtn.addEventListener('click', sendFile);
});

// 연결 상태 변화 시 sendFileBtn 활성화/비활성화
function updateSendFileButtonState() {
    sendFileBtn.disabled = fileInput.files.length === 0 || peerConnection.connectionState !== 'connected';
}
// ===========================================================================


// ====== WebSocket (시그널링) 로직 ============================================
function connectWebSocket() {
    ws = new WebSocket(RAILWAY_SIGNALING_SERVER_URL);

    ws.onopen = () => {
        console.log('Railway 시그널링 서버에 연결되었습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결됨 (P2P 연결 대기 중)';
    };

    ws.onmessage = async event => {
        const message = JSON.parse(event.data);
        console.log('시그널링 메시지 수신:', message.type);

        if (!peerConnection) {
            createPeerConnection(); // peerConnection이 없으면 생성
        }

        if (message.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify(answer));
        } else if (message.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
        } else if (message.type === 'candidate') {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message));
            } catch (e) {
                console.error('ICE candidate 추가 실패:', e);
            }
        }
    };

    ws.onclose = () => {
        console.log('시그널링 서버 연결이 끊어졌습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결 끊김';
        // 재연결 로직 추가 가능
    };

    ws.onerror = error => {
        console.error('WebSocket 오류 발생:', error);
        connectionStatus.textContent = '연결 상태: 시그널링 서버 오류 발생';
    };
}
// ===========================================================================


// ====== WebRTC PeerConnection 로직 =========================================
function createPeerConnection() {
    const configuration = {
        iceServers: [{ urls: STUN_SERVER_URL }]
    };
    peerConnection = new RTCPeerConnection(configuration);

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            console.log('ICE candidate 전송:', event.candidate.candidate);
            ws.send(JSON.stringify(event.candidate));
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC 연결 상태:', peerConnection.connectionState);
        connectionStatus.textContent = `연결 상태: ${peerConnection.connectionState}`;
        updateSendFileButtonState(); // 연결 상태 변경 시 버튼 상태 업데이트
    };

    // 상대방이 DataChannel을 생성했을 때 (수신자 측)
    peerConnection.ondatachannel = event => {
        receiveChannel = event.channel;
        setupReceiveChannel(receiveChannel);
    };
}

async function createPeerConnectionAndOffer() {
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        console.log('이미 PeerConnection이 존재하거나 연결 중입니다.');
        return;
    }

    createPeerConnection();

    // DataChannel 생성 (송신자 측)
    sendChannel = peerConnection.createDataChannel('fileTransfer');
    setupSendChannel(sendChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify(offer)); // Offer를 시그널링 서버로 보냅니다.
    connectBtn.disabled = true; // 연결 시작 버튼 비활성화
}
// ===========================================================================


// ====== DataChannel 설정 로직 (송신) =========================================
function setupSendChannel(channel) {
    channel.onopen = () => {
        console.log('송신 DataChannel 열림!');
        updateSendFileButtonState();
        sendFileStatus.textContent = '파일 전송 준비 완료.';
    };
    channel.onclose = () => {
        console.log('송신 DataChannel 닫힘!');
        updateSendFileButtonState();
        sendFileStatus.textContent = '파일 전송 채널 닫힘.';
    };
    channel.onerror = error => {
        console.error('송신 DataChannel 오류:', error);
        sendFileStatus.textContent = `파일 전송 채널 오류: ${error.message}`;
    };
    // 송신 채널은 메시지를 받지 않으므로 onmessage는 필요 없음
}

async function sendFile() {
    const file = fileInput.files[0];
    if (!file || !sendChannel || sendChannel.readyState !== 'open') {
        sendFileStatus.textContent = '파일을 선택하거나 P2P 연결이 완료되지 않았습니다.';
        return;
    }

    sendFileBtn.disabled = true; // 전송 중에는 버튼 비활성화
    sendFileStatus.textContent = `파일 전송 시작: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;

    const metadata = {
        filename: file.name,
        filesize: file.size,
        filetype: file.type
    };
    // 파일 메타데이터를 먼저 전송
    sendChannel.send(JSON.stringify(metadata));

    let offset = 0;
    const fileReader = new FileReader();

    fileReader.onprogress = (e) => {
        const percent = Math.floor((offset / file.size) * 100);
        sendFileStatus.textContent = `전송 중: ${file.name} (${percent}%)`;
    };

    fileReader.onload = (e) => {
        sendChannel.send(e.target.result); // ArrayBuffer 형태로 전송
        offset += e.target.result.byteLength;
        if (offset < file.size) {
            readNextChunk();
        } else {
            sendFileStatus.textContent = `파일 전송 완료: ${file.name}`;
            sendChannel.send('EOM'); // End Of Message - 파일 전송 완료 신호
            fileInput.value = ''; // 파일 입력 필드 초기화
        }
    };

    fileReader.onerror = (e) => {
        console.error('파일 읽기 오류:', e);
        sendFileStatus.textContent = '파일 읽기 중 오류 발생.';
        sendFileBtn.disabled = false; // 오류 시 버튼 다시 활성화
    };

    function readNextChunk() {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        fileReader.readAsArrayBuffer(slice);
    }

    readNextChunk(); // 첫 번째 청크 읽기 시작
}
// ===========================================================================


// ====== DataChannel 설정 로직 (수신) =========================================
function setupReceiveChannel(channel) {
    channel.onopen = () => {
        console.log('수신 DataChannel 열림!');
        receiveStatus.textContent = '파일 수신 대기 중...';
    };
    channel.onclose = () => {
        console.log('수신 DataChannel 닫힘!');
        receiveStatus.textContent = '파일 수신 채널 닫힘.';
    };
    channel.onerror = error => {
        console.error('수신 DataChannel 오류:', error);
        receiveStatus.textContent = `파일 수신 채널 오류: ${error.message}`;
    };

    channel.onmessage = handleReceiveMessage;
}

function handleReceiveMessage(event) {
    // 메시지가 문자열이면 메타데이터 또는 완료 신호
    if (typeof event.data === 'string') {
        if (event.data === 'EOM') { // 파일 전송 완료 신호
            if (receivedMetadata && receivedFileBuffers.length > 0) {
                const receivedBlob = new Blob(receivedFileBuffers, { type: receivedMetadata.filetype });
                const url = URL.createObjectURL(receivedBlob);
                
                const li = document.createElement('li');
                li.innerHTML = `
                    <span>${receivedMetadata.filename} (${(receivedSize / (1024 * 1024)).toFixed(2)} MB)</span>
                    <a href="${url}" download="${receivedMetadata.filename}" class="btn">다운로드</a>
                `;
                receivedFilesList.appendChild(li);

                receiveStatus.textContent = `파일 수신 완료: ${receivedMetadata.filename}`;
                // 다음 파일 수신을 위해 초기화
                receivedFileBuffers = [];
                receivedMetadata = null;
                receivedSize = 0;
            }
        } else { // 메타데이터
            receivedMetadata = JSON.parse(event.data);
            receivedFileBuffers = []; // 새 파일 수신 준비
            receivedSize = 0;
            receiveStatus.textContent = `파일 수신 시작: ${receivedMetadata.filename} (0%)`;
            receivedFilesList.innerHTML = ''; // 새 파일 받기 시작하면 목록 초기화 (선택 사항)
            console.log('파일 메타데이터 수신:', receivedMetadata);
        }
    } else { // 메시지가 ArrayBuffer면 파일 청크
        if (receivedMetadata) {
            receivedFileBuffers.push(event.data);
            receivedSize += event.data.byteLength;
            const percent = Math.floor((receivedSize / receivedMetadata.filesize) * 100);
            receiveStatus.textContent = `파일 수신 중: ${receivedMetadata.filename} (${percent}%)`;
        }
    }
}
// ===========================================================================
