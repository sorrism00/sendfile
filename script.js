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
let ws; // WebSocket 연결 객체
let peerConnection; // RTCPeerConnection 객체 (P2P 연결 담당)
let sendChannel; // 파일 송신용 RTCDataChannel
let receiveChannel; // 파일 수신용 RTCDataChannel

let receivedFileBuffers = []; // 수신된 파일 청크(ArrayBuffer)들을 저장할 배열
let receivedMetadata = null; // 수신된 파일의 메타데이터 (이름, 크기, 타입 등)
let receivedSize = 0; // 현재까지 수신된 파일 크기 (바이트 단위)
// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. WebSocket (시그널링 서버) 연결 시작
    connectWebSocket();

    // 2. UI 요소에 이벤트 리스너 등록
    connectBtn.addEventListener('click', createPeerConnectionAndOffer); // "연결 시작" 버튼
    fileInput.addEventListener('change', updateSendFileButtonState);   // 파일 선택 입력창
    sendFileBtn.addEventListener('click', sendFile);                   // "파일 전송" 버튼

    // 3. 초기 UI 상태 설정
    updateSendFileButtonState();
});

/**
 * UI 버튼들의 활성화/비활성화 상태를 업데이트합니다.
 * P2P 연결 상태와 파일 선택 여부에 따라 버튼 상태가 변경됩니다.
 */
function updateSendFileButtonState() {
    // "파일 전송" 버튼 활성화 조건: P2P 연결 완료 AND 파일 선택됨
    const isConnectedAndFileSelected = peerConnection && 
                                       peerConnection.connectionState === 'connected' && 
                                       fileInput.files.length > 0;
    sendFileBtn.disabled = !isConnectedAndFileSelected;

    // "연결 시작" 버튼 비활성화 조건: PeerConnection이 이미 존재하고 닫히지 않은 상태
    // (즉, 연결 시도 중이거나 연결된 상태)
    const isPeerConnectionActive = peerConnection && peerConnection.connectionState !== 'closed';
    connectBtn.disabled = isPeerConnectionActive;

    // 만약 WebSocket이 끊어졌다면 connectBtn은 다시 활성화될 수 있습니다.
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectBtn.disabled = false;
    }
}
// ===========================================================================


// ====== WebSocket (시그널링) 로직 ============================================
/**
 * Railway 시그널링 서버에 WebSocket 연결을 수립합니다.
 */
function connectWebSocket() {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
        console.warn('WebSocket이 이미 연결되어 있거나 연결 중입니다. 새로 연결을 시도하지 않습니다.');
        return; // 이미 연결되어 있다면 다시 연결 시도 안함
    }

    ws = new WebSocket(RAILWAY_SIGNALING_SERVER_URL);

    ws.onopen = () => {
        console.log('Railway 시그널링 서버에 연결되었습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결됨 (P2P 연결 대기 중)';
        updateSendFileButtonState();
    };

    ws.onmessage = async event => {
        const messageString = event.data; // 받은 메시지는 항상 문자열로 가정

        let message;
        try {
            message = JSON.parse(messageString);
            // 디버깅을 위해 메시지 타입과 전체 메시지 객체를 함께 로깅합니다.
            console.log('시그널링 메시지 수신:', message.type || '[type undefined]', message); 
        } catch (e) {
            console.error('JSON 파싱 오류: 유효하지 않은 시그널링 메시지 수신', messageString, e);
            return; // 파싱 실패 시 더 이상 처리하지 않고 함수 종료
        }

        // peerConnection이 아직 생성되지 않았다면, 메시지를 받기 전에 생성
        // offer나 answer를 받기 전에 candidate가 올 수도 있으므로, 이 부분에서 먼저 PeerConnection 생성
        if (!peerConnection || peerConnection.connectionState === 'closed') { // P2P 연결이 없거나 닫혔다면 새로 생성
            createPeerConnection();
        }

        // 메시지 타입에 따라 WebRTC 시그널링 처리
        if (message.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify(answer));
        } else if (message.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
        } else if (message.type === 'candidate') {
            try {
                // 받은 ICE Candidate를 PeerConnection에 추가
                // message.candidate 자체가 RTCIceCandidateInit 딕셔너리여야 합니다.
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)); // <-- message.candidate 사용
            } catch (e) {
                console.error('ICE candidate 추가 실패:', e, message.candidate);
            }
        }
    };

    ws.onclose = () => {
        console.log('시그널링 서버 연결이 끊어졌습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결 끊김';
        
        // P2P 연결도 닫아야 함 (연결 끊김에 따른 리소스 정리)
        if (peerConnection && peerConnection.connectionState !== 'closed') {
            peerConnection.close();
        }
        peerConnection = null; // PeerConnection 객체 초기화
        updateSendFileButtonState();
        // TODO: 필요하다면 재연결 로직 추가
    };

    ws.onerror = error => {
        console.error('WebSocket 오류 발생:', error);
        connectionStatus.textContent = '연결 상태: 시그널링 서버 오류 발생';
        
        // P2P 연결도 닫아야 함
        if (peerConnection && peerConnection.connectionState !== 'closed') {
            peerConnection.close();
        }
        peerConnection = null; // PeerConnection 객체 초기화
        updateSendFileButtonState();
    };
}
// ===========================================================================


// ====== WebRTC PeerConnection 로직 =========================================
/**
 * RTCPeerConnection 객체를 생성하고 이벤트 핸들러를 설정합니다.
 */
function createPeerConnection() {
    // 이전 peerConnection이 닫히지 않았다면 닫고 새로 만듭니다.
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        peerConnection.close();
    }

    const configuration = {
        iceServers: [{ urls: STUN_SERVER_URL }] // STUN 서버 설정
    };
    peerConnection = new RTCPeerConnection(configuration);

    // ICE Candidate 이벤트: 로컬 네트워크 정보를 상대방에게 시그널링 서버를 통해 전송
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            console.log('ICE candidate 전송:', event.candidate.candidate);
            // 명시적으로 type 필드를 포함한 객체로 감싸서 전송합니다.
            ws.send(JSON.stringify({
                type: 'candidate', // <-- 여기에 'type' 필드 추가!
                candidate: event.candidate // RTCIceCandidate 객체 자체를 candidate 속성에 넣습니다.
            }));
        }
    };

    // P2P 연결 상태 변화 이벤트
    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC 연결 상태:', peerConnection.connectionState);
        connectionStatus.textContent = `연결 상태: ${peerConnection.connectionState}`;
        updateSendFileButtonState(); // 연결 상태 변경 시 버튼 상태 업데이트
    };

    // 상대방이 DataChannel을 생성했을 때 (수신자 측에서 발생)
    peerConnection.ondatachannel = event => {
        console.log('상대방으로부터 DataChannel 수신:', event.label);
        receiveChannel = event.channel;
        setupReceiveChannel(receiveChannel);
    };
}

/**
 * "연결 시작" 버튼 클릭 시 실행됩니다.
 * PeerConnection을 생성하고 Offer를 생성하여 시그널링 서버로 전송합니다.
 */
async function createPeerConnectionAndOffer() {
    // 이미 PeerConnection이 활성 상태이면 중복 실행 방지
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        console.log('이미 PeerConnection이 존재하거나 연결 시도 중입니다. 재연결을 시도하지 않습니다.');
        return;
    }

    // WebSocket이 연결되지 않았다면 먼저 연결 시도
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        console.warn('WebSocket이 연결되어 있지 않습니다. 먼저 시그널링 서버에 연결합니다.');
        connectWebSocket(); // WebSocket 재연결 시도
        // WebSocket이 연결될 때까지 대기하는 로직을 추가하는 것이 더 견고할 수 있습니다.
        // 현재는 connectWebSocket 후 바로 진행되므로, 네트워크 상황에 따라 onopen이 먼저 발생하지 않을 수 있음.
    }
    if (ws.readyState !== WebSocket.OPEN) {
        console.log('WebSocket 연결 대기 중... 잠시 후 다시 시도합니다.');
        setTimeout(createPeerConnectionAndOffer, 1000); // 1초 후 다시 시도
        return;
    }


    // 1. PeerConnection 생성
    createPeerConnection();

    // 2. DataChannel 생성 (파일 송신용, 발신자 측에서 생성)
    sendChannel = peerConnection.createDataChannel('fileTransfer'); // 채널 이름 지정
    setupSendChannel(sendChannel);

    // 3. Offer 생성 및 LocalDescription 설정
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // 4. Offer를 시그널링 서버로 전송 (명시적으로 type 필드 추가)
    ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, type: offer.type })); 
    
    // 5. UI 업데이트
    updateSendFileButtonState(); 
}
// ===========================================================================


// ====== DataChannel 설정 로직 (송신) =========================================
/**
 * 송신용 DataChannel의 이벤트 핸들러를 설정합니다.
 * @param {RTCDataChannel} channel - 송신용 DataChannel 객체
 */
function setupSendChannel(channel) {
    channel.onopen = () => {
        console.log('송신 DataChannel 열림!');
        updateSendFileButtonState();
        sendFileStatus.textContent = '파일 전송 준비 완료. 파일을 선택해 주세요.';
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
    // 송신 채널은 주로 데이터를 보내는 역할이므로 onmessage는 일반적으로 필요 없음
}

/**
 * 선택된 파일을 DataChannel을 통해 전송합니다.
 */
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
    // 파일 메타데이터(이름, 크기, 타입)를 먼저 JSON 문자열로 전송
    sendChannel.send(JSON.stringify(metadata));

    let offset = 0;
    const fileReader = new FileReader();

    fileReader.onprogress = (e) => {
        // 실제 전송되는 offset 기준으로 진행률 계산
        const percent = Math.floor((offset / file.size) * 100); 
        sendFileStatus.textContent = `전송 중: ${file.name} (${percent}%)`;
    };

    fileReader.onload = (e) => {
        sendChannel.send(e.target.result); // ArrayBuffer 형태로 파일 청크 전송
        offset += e.target.result.byteLength; // 전송된 바이트만큼 offset 증가

        if (offset < file.size) {
            readNextChunk(); // 다음 청크 읽기
        } else {
            // 모든 청크 전송 완료
            sendFileStatus.textContent = `파일 전송 완료: ${file.name}`;
            sendChannel.send('EOM'); // End Of Message - 파일 전송 완료 신호 전송
            fileInput.value = ''; // 파일 입력 필드 초기화 (선택 사항)
            updateSendFileButtonState(); // 전송 완료 후 버튼 상태 업데이트
        }
    };

    fileReader.onerror = (e) => {
        console.error('파일 읽기 오류:', e);
        sendFileStatus.textContent = '파일 읽기 중 오류 발생.';
        sendFileBtn.disabled = false; // 오류 시 버튼 다시 활성화
    };

    /**
     * 파일의 다음 청크를 읽어옵니다.
     */
    function readNextChunk() {
        // 파일에서 현재 offset부터 CHUNK_SIZE만큼의 데이터를 잘라냄
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        fileReader.readAsArrayBuffer(slice); // 잘라낸 데이터를 ArrayBuffer로 읽기 시작
    }

    readNextChunk(); // 파일 전송 시작: 첫 번째 청크 읽기 시작
}
// ===========================================================================


// ====== DataChannel 설정 로직 (수신) =========================================
/**
 * 수신용 DataChannel의 이벤트 핸들러를 설정합니다.
 * @param {RTCDataChannel} channel - 수신용 DataChannel 객체
 */
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

    channel.onmessage = handleReceiveMessage; // 메시지 수신 시 처리 함수
}

/**
 * DataChannel을 통해 수신된 메시지를 처리합니다.
 * 파일 메타데이터 수신, 파일 청크 수신, 파일 전송 완료 신호 등을 처리합니다.
 * @param {MessageEvent} event - DataChannel로부터 수신된 메시지 이벤트 객체
 */
function handleReceiveMessage(event) {
    // 메시지가 문자열이면 메타데이터 또는 전송 완료 신호
    if (typeof event.data === 'string') {
        if (event.data === 'EOM') { // 파일 전송 완료 신호 (End Of Message)
            if (receivedMetadata && receivedFileBuffers.length > 0) {
                // 수신된 모든 청크들을 하나로 합쳐 Blob 객체 생성
                const receivedBlob = new Blob(receivedFileBuffers, { type: receivedMetadata.filetype });
                const url = URL.createObjectURL(receivedBlob); // Blob URL 생성 (다운로드 링크용)
                
                // 수신된 파일 목록 UI 업데이트
                const li = document.createElement('li');
                li.innerHTML = `
                    <span>${receivedMetadata.filename} (${(receivedSize / (1024 * 1024)).toFixed(2)} MB)</span>
                    <a href="${url}" download="${receivedMetadata.filename}" class="btn">다운로드</a>
                `;
                receivedFilesList.appendChild(li);

                receiveStatus.textContent = `파일 수신 완료: ${receivedMetadata.filename}`;
                
                // 다음 파일 수신을 위해 변수 초기화
                receivedFileBuffers = [];
                receivedMetadata = null;
                receivedSize = 0;
                console.log('파일 수신 완료 및 초기화');
            }
        } else { // 파일 메타데이터 수신 (JSON 문자열)
            try {
                receivedMetadata = JSON.parse(event.data);
                receivedFileBuffers = []; // 새 파일 수신 준비
                receivedSize = 0;
                receiveStatus.textContent = `파일 수신 시작: ${receivedMetadata.filename} (0%)`;
                receivedFilesList.innerHTML = ''; // 새 파일 받기 시작하면 기존 목록 초기화 (선택 사항)
                console.log('파일 메타데이터 수신:', receivedMetadata);
            } catch (e) {
                console.error('수신된 메타데이터 파싱 오류:', event.data, e);
                receiveStatus.textContent = '메타데이터 수신 오류.';
            }
        }
    } else { // 메시지가 ArrayBuffer면 파일 청크 데이터
        if (receivedMetadata) { // 메타데이터가 있어야 파일 청크로 처리
            receivedFileBuffers.push(event.data); // 수신된 청크를 배열에 추가
            receivedSize += event.data.byteLength; // 수신된 크기 업데이트
            const percent = Math.floor((receivedSize / receivedMetadata.filesize) * 100);
            receiveStatus.textContent = `파일 수신 중: ${receivedMetadata.filename} (${percent}%)`;
        } else {
            console.warn('메타데이터 없이 파일 청크 수신됨, 무시합니다.');
        }
    }
}
// ===========================================================================
