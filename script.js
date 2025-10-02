// ====== 설정 영역 ==========================================================
// Railway 시그널링 서버의 실제 URL로 변경해야 합니다.
// 예: 'wss://your-sendfile-signaling-server-abcd.up.railway.app'
const RAILWAY_SIGNALING_SERVER_URL = 'wss://sendfile-signaling-server-production.up.railway.app'; 
const STUN_SERVER_URL = 'stun:stun.l.google.com:19302';
const CHUNK_SIZE = 16 * 1024; // 16KB (WebRTC DataChannel 권장 청크 크기)
const DATA_CHANNEL_BUFFER_THRESHOLD = 10 * 1024 * 1024; // 10MB (DataChannel 버퍼 흐름 제어 임계값)
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

let fileQueue = []; // 전송 대기 중인 파일 큐
let currentSendingFile = null; // 현재 전송 중인 파일 객체
let currentFileReader = null; // 현재 전송 중인 파일을 읽는 FileReader 객체

let receivedFileBuffers = []; // 수신된 파일 청크(ArrayBuffer)들을 저장할 배열 (Filesystem Access API 미지원 시)
let receivedMetadata = null; // 수신된 파일의 메타데이터 (이름, 크기, 타입 등)
let receivedSize = 0; // 현재까지 수신된 파일 크기 (바이트 단위)
let fileHandle = null; // FileSystemFileHandle 객체 (Filesystem Access API 사용 시)
let writableStream = null; // FileSystemWritableFileStream 객체 (Filesystem Access API 사용 시)
// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. WebSocket (시그널링 서버) 연결 시작
    connectWebSocket();

    // 2. UI 요소에 이벤트 리스너 등록
    connectBtn.addEventListener('click', createPeerConnectionAndOffer); // "연결 시작" 버튼
    fileInput.addEventListener('change', handleFileSelection);          // 파일 선택 입력창 (multiple)
    sendFileBtn.addEventListener('click', processFileQueue);             // "파일 전송" 버튼 (큐 처리 시작)

    // 3. 초기 UI 상태 설정
    updateSendFileButtonState();
});

/**
 * UI 버튼들의 활성화/비활성화 상태를 업데이트합니다.
 * P2P 연결 상태와 파일 큐 상태에 따라 버튼 상태가 변경됩니다.
 */
function updateSendFileButtonState() {
    const isConnected = peerConnection && peerConnection.connectionState === 'connected';
    const hasFilesToSend = currentSendingFile || fileQueue.length > 0;

    // "파일 전송" 버튼 활성화 조건: P2P 연결 완료 AND (전송 중인 파일 있거나 큐에 파일 있음)
    sendFileBtn.disabled = !(isConnected && hasFilesToSend);
    sendFileBtn.textContent = currentSendingFile 
        ? `전송 중... (${fileQueue.length}개 남음)` 
        : `파일 전송 (${fileQueue.length}개 대기)`;
    if (!hasFilesToSend) sendFileBtn.textContent = '파일 전송'; // 큐에 아무것도 없으면 원래 텍스트로

    // "연결 시작" 버튼 비활성화 조건: PeerConnection이 이미 존재하고 닫히지 않은 상태
    const isPeerConnectionActive = peerConnection && peerConnection.connectionState !== 'closed';
    connectBtn.disabled = isPeerConnectionActive;

    // WebSocket 연결이 끊어졌다면 "연결 시작" 버튼은 다시 활성화될 수 있습니다.
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectBtn.disabled = false;
    }
}

/**
 * 파일 선택 입력창에서 파일 선택 시 호출되는 핸들러.
 * 선택된 파일을 전송 큐에 추가합니다.
 */
function handleFileSelection() {
    const files = Array.from(fileInput.files);
    if (files.length > 0) {
        fileQueue.push(...files); // 선택된 모든 파일을 큐에 추가
        fileInput.value = ''; // 다음 파일 선택을 위해 입력창 초기화
        sendFileStatus.textContent = `${files.length}개의 파일이 큐에 추가되었습니다. 총 ${fileQueue.length}개 대기.`;
        
        // 현재 전송 중인 파일이 없다면 새 파일 전송 시작
        if (!currentSendingFile && peerConnection && peerConnection.connectionState === 'connected') {
            processFileQueue();
        }
    }
    updateSendFileButtonState(); // 버튼 상태 업데이트
}
// ===========================================================================


// ====== WebSocket (시그널링) 로직 ============================================
/**
 * Railway 시그널링 서버에 WebSocket 연결을 수립합니다.
 */
function connectWebSocket() {
    // 이미 연결되어 있거나 연결 중이라면 새로 연결 시도 안함
    if (ws && ws.readyState !== WebSocket.CLOSED) {
        console.warn('WebSocket이 이미 연결되어 있거나 연결 중입니다. 새로 연결을 시도하지 않습니다.');
        return;
    }

    ws = new WebSocket(RAILWAY_SIGNALING_SERVER_URL);

    ws.onopen = () => {
        console.log('Railway 시그널링 서버에 연결되었습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결됨 (P2P 연결 대기 중)';
        updateSendFileButtonState();
    };

    ws.onmessage = async event => {
        const messageString = event.data;

        let message;
        try {
            message = JSON.parse(messageString);
            console.log('시그널링 메시지 수신:', message.type || '[type undefined]', message); 
        } catch (e) {
            console.error('JSON 파싱 오류: 유효하지 않은 시그널링 메시지 수신', messageString, e);
            return; // 파싱 실패 시 더 이상 처리하지 않고 함수 종료
        }

        // peerConnection이 아직 생성되지 않았거나 닫혔다면 새로 생성
        if (!peerConnection || peerConnection.connectionState === 'closed') { 
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
                // 수신된 ICE Candidate는 message.candidate 속성 안에 있습니다.
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)); 
            } catch (e) {
                console.error('ICE candidate 추가 실패:', e, message.candidate);
            }
        }
    };

    ws.onclose = () => {
        console.log('시그널링 서버 연결이 끊어졌습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결 끊김';
        
        // WebSocket이 닫히면 PeerConnection 및 전송 큐도 초기화
        closePeerConnectionAndClearQueues();
        updateSendFileButtonState();
        // TODO: 필요하다면 자동 재연결 로직 추가
    };

    ws.onerror = error => {
        console.error('WebSocket 오류 발생:', error);
        connectionStatus.textContent = '연결 상태: 시그널링 서버 오류 발생';
        
        // WebSocket 오류 발생 시 PeerConnection 및 전송 큐도 초기화
        closePeerConnectionAndClearQueues();
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
            // 명시적으로 type 필드를 포함한 객체로 감싸서 전송합니다. (서버 측에서도 이 형식으로 파싱)
            ws.send(JSON.stringify({
                type: 'candidate', 
                candidate: event.candidate 
            }));
        }
    };

    // P2P 연결 상태 변화 이벤트
    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC 연결 상태:', peerConnection.connectionState);
        connectionStatus.textContent = `연결 상태: ${peerConnection.connectionState}`;
        updateSendFileButtonState(); // 연결 상태 변경 시 버튼 상태 업데이트

        if (peerConnection.connectionState === 'connected') {
            // P2P 연결 완료 시, 전송 대기 중인 파일이 있다면 전송 시작
            if (fileQueue.length > 0 && !currentSendingFile) {
                processFileQueue();
            }
        }
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
        console.log('WebSocket이 연결되어 있지 않습니다. 먼저 시그널링 서버에 연결을 시도합니다.');
        connectWebSocket(); // WebSocket 재연결 시도
    }

    // WebSocket 연결이 열릴 때까지 대기
    if (ws.readyState !== WebSocket.OPEN) {
        console.log('WebSocket 연결 대기 중... 1초 후 다시 시도합니다.');
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
    ws.send(JSON.stringify({ type: offer.type, sdp: offer.sdp })); 
    
    // 5. UI 업데이트
    updateSendFileButtonState(); 
}

/**
 * WebSocket 또는 PeerConnection이 끊어지거나 오류 발생 시 관련 리소스를 정리합니다.
 */
function closePeerConnectionAndClearQueues() {
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        peerConnection.close();
        console.log('PeerConnection 닫힘.');
    }
    peerConnection = null;

    if (sendChannel) {
        sendChannel.close();
        sendChannel = null;
    }
    if (receiveChannel) {
        receiveChannel.close();
        receiveChannel = null;
    }

    fileQueue = []; // 파일 큐 초기화
    currentSendingFile = null; // 현재 전송 파일 초기화
    currentFileReader = null; // FileReader 초기화

    receivedFileBuffers = [];
    receivedMetadata = null;
    receivedSize = 0;
    if (writableStream) {
        try { writableStream.close(); } catch (e) { console.error("Error closing writable stream:", e); }
        writableStream = null;
    }
    fileHandle = null;

    sendFileStatus.textContent = '전송할 파일을 선택해 주세요.';
    receiveStatus.textContent = '파일 수신 대기 중...';
    receivedFilesList.innerHTML = '';
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
        // DataChannel이 열리면, 큐에 있는 파일 전송 시작 시도
        if (fileQueue.length > 0 && !currentSendingFile) {
            processFileQueue();
        }
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

    // 흐름 제어(Flow Control)를 위한 버퍼 임계값 설정
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_THRESHOLD; // 예: 10MB
    channel.onbufferedamountlow = () => {
        console.log('bufferedAmountLow 이벤트 발생. 데이터 전송 재개 시도. bufferedAmount:', channel.bufferedAmount);
        // 버퍼가 비워지면 다음 청크 전송 시도
        if (currentSendingFile) {
            attemptToSendNextChunk(currentSendingFile);
        }
    };
}

/**
 * 파일 전송 큐를 처리하여 다음 파일을 전송합니다.
 */
function processFileQueue() {
    // 현재 전송 중인 파일이 없고, 큐에 파일이 있고, DataChannel이 열려있어야 전송 시작
    if (!currentSendingFile && fileQueue.length > 0 && sendChannel && sendChannel.readyState === 'open') {
        currentSendingFile = fileQueue.shift(); // 큐에서 다음 파일 가져오기
        currentSendingFile._offset = 0; // 파일 객체에 현재 전송 위치 저장 (내부적으로)
        sendFileStatus.textContent = `파일 전송 시작: ${currentSendingFile.name} (${(currentSendingFile.size / (1024 * 1024)).toFixed(2)} MB)`;
        
        currentFileReader = new FileReader(); // 새 FileReader 생성

        currentFileReader.onprogress = (e) => {
            const percent = Math.floor((currentSendingFile._offset / currentSendingFile.size) * 100);
            sendFileStatus.textContent = `전송 중: ${currentSendingFile.name} (${percent}%)`;
        };

        currentFileReader.onload = (e) => {
            sendChannel.send(e.target.result); // ArrayBuffer 형태로 전송
            currentSendingFile._offset += e.target.result.byteLength;
            
            attemptToSendNextChunk(currentSendingFile); // 다음 청크 전송 시도
        };

        currentFileReader.onerror = (e) => {
            console.error('파일 읽기 오류:', e);
            sendFileStatus.textContent = `파일 읽기 중 오류 발생: ${currentSendingFile.name}`;
            currentSendingFile = null; // 오류 발생 시 현재 파일 초기화
            currentFileReader = null;
            processFileQueue(); // 다음 파일 전송 시도
            updateSendFileButtonState();
        };

        // 첫 청크 전송 시작
        attemptToSendNextChunk(currentSendingFile);
        
    } else if (fileQueue.length === 0 && !currentSendingFile) {
        sendFileStatus.textContent = '전송할 파일이 없습니다.';
        updateSendFileButtonState();
    } else {
        // 전송 중이거나 DataChannel이 준비되지 않음
        updateSendFileButtonState(); // 버튼 텍스트 업데이트용으로 호출
    }
}

/**
 * DataChannel 버퍼 상태를 확인하여 다음 청크를 전송 시도합니다. (백프레셔 로직)
 * @param {File} file - 현재 전송할 파일
 */
function attemptToSendNextChunk(file) {
    if (!sendChannel || sendChannel.readyState !== 'open') {
        sendFileStatus.textContent = `P2P 연결이 끊겨 ${file.name} 전송을 중단합니다.`;
        currentSendingFile = null;
        currentFileReader = null;
        processFileQueue(); // 큐에 다음 파일이 있다면 처리
        updateSendFileButtonState();
        return;
    }

    if (sendChannel.bufferedAmount > sendChannel.bufferedAmountLowThreshold) {
        // DataChannel 버퍼가 임계값을 초과하면 전송 일시 중지
        console.log('DataChannel 버퍼 가득 참. 전송 일시 중지. bufferedAmount:', sendChannel.bufferedAmount);
        return; // onbufferedamountlow 이벤트가 발생할 때까지 대기
    }

    // 파일 메타데이터 (이름, 크기 등)가 먼저 전송되어야 합니다.
    // 첫 청크 전송 직전 메타데이터 전송
    if (file._offset === 0) {
        const metadata = {
            filename: file.name,
            filesize: file.size,
            filetype: file.type
        };
        sendChannel.send(JSON.stringify(metadata));
        console.log('파일 메타데이터 전송:', metadata.filename);
    }
    
    if (file._offset < file.size) {
        const slice = file.slice(file._offset, file._offset + CHUNK_SIZE);
        currentFileReader.readAsArrayBuffer(slice); // 다음 청크 읽기 시작 (onload에서 sendChannel.send 호출)
    } else {
        // 모든 청크 전송 완료
        sendFileStatus.textContent = `파일 전송 완료: ${file.name}`;
        sendChannel.send('EOM'); // End Of Message - 파일 전송 완료 신호
        
        currentSendingFile = null; // 현재 전송 파일 초기화
        currentFileReader = null; // FileReader 초기화
        console.log('모든 청크 전송 완료. 다음 파일 처리 시작.');
        processFileQueue(); // 큐에서 다음 파일 전송 시도
        updateSendFileButtonState();
    }
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
        closeFileStreamsAndClearReceiveState(); // 수신 채널 닫히면 스트림 정리
    };
    channel.onerror = error => {
        console.error('수신 DataChannel 오류:', error);
        receiveStatus.textContent = `파일 수신 채널 오류: ${error.message}`;
        closeFileStreamsAndClearReceiveState(); // 오류 시 스트림 정리
    };

    channel.onmessage = handleReceiveMessage; // 메시지 수신 시 처리 함수
}

/**
 * DataChannel을 통해 수신된 메시지를 처리합니다.
 * 파일 메타데이터 수신, 파일 청크 수신, 파일 전송 완료 신호 등을 처리합니다.
 * @param {MessageEvent} event - DataChannel로부터 수신된 메시지 이벤트 객체
 */
async function handleReceiveMessage(event) {
    // 메시지가 문자열이면 메타데이터 또는 전송 완료 신호
    if (typeof event.data === 'string') {
        if (event.data === 'EOM') { // 파일 전송 완료 신호 (End Of Message)
            if (receivedMetadata) { // 메타데이터가 있어야 유효한 전송 완료 신호로 간주
                if (writableStream) { // FileSystem Access API 사용 중이었다면
                    try {
                        await writableStream.close(); // 스트림 닫기
                        const li = document.createElement('li');
                        li.innerHTML = `
                            <span>${receivedMetadata.filename} (${(receivedSize / (1024 * 1024)).toFixed(2)} MB)</span>
                            <span class="status-badge">저장 완료됨</span>
                        `;
                        receivedFilesList.appendChild(li);
                        receiveStatus.textContent = `파일 수신 완료 및 디스크 저장: ${receivedMetadata.filename}`;
                        console.log('파일 수신 완료 및 스트림 종료.');
                    } catch (e) {
                        console.error('파일 스트림 닫기 오류:', e);
                        receiveStatus.textContent = `수신 오류 (스트림 닫기 실패): ${e.message}`;
                    } finally {
                        closeFileStreamsAndClearReceiveState();
                    }
                } else if (receivedFileBuffers.length > 0) { // FileSystem Access API 미지원/실패 시 Blob으로 재구성
                    const receivedBlob = new Blob(receivedFileBuffers, { type: receivedMetadata.filetype });
                    const url = URL.createObjectURL(receivedBlob); // Blob URL 생성 (다운로드 링크용)
                    
                    const li = document.createElement('li');
                    li.innerHTML = `
                        <span>${receivedMetadata.filename} (${(receivedSize / (1024 * 1024)).toFixed(2)} MB)</span>
                        <a href="${url}" download="${receivedMetadata.filename}" class="btn">다운로드</a>
                    `;
                    receivedFilesList.appendChild(li);

                    receiveStatus.textContent = `파일 수신 완료 (메모리): ${receivedMetadata.filename}`;
                    closeFileStreamsAndClearReceiveState();
                    console.log('파일 수신 완료 및 초기화 (Blob).');
                }
            } else {
                console.warn('EOM 신호가 메타데이터 없이 수신됨, 무시합니다.');
            }
        } else { // 파일 메타데이터 수신 (JSON 문자열)
            try {
                receivedMetadata = JSON.parse(event.data);
                receivedFileBuffers = []; 
                receivedSize = 0;
                receivedFilesList.innerHTML = ''; // 새 파일 받기 시작하면 기존 목록 초기화

                // FileSystem Access API 지원 여부 확인 및 사용 시도 (대용량 파일에 효과적)
                if ('showSaveFilePicker' in window && 'FileSystemWritableFileStream' in window) {
                    try {
                        // 사용자에게 파일 저장 위치 선택 요청
                        fileHandle = await window.showSaveFilePicker({
                            suggestedName: receivedMetadata.filename,
                            types: [{
                                description: 'File to save',
                                accept: { [receivedMetadata.filetype]: ['.' + (receivedMetadata.filename.split('.').pop() || 'dat')] }
                            }]
                        });
                        writableStream = await fileHandle.createWritable();
                        receiveStatus.textContent = `파일 수신 시작 (디스크 스트림): ${receivedMetadata.filename} (0%)`;
                        console.log('FilesystemWritableFileStream 생성됨.');
                    } catch (err) {
                        console.warn('Filesystem Access API 사용 거부 또는 오류:', err);
                        // 오류 발생 시 또는 지원하지 않을 경우 기존 Blob 방식으로 폴백
                        fileHandle = null;
                        writableStream = null;
                        receiveStatus.textContent = `파일 수신 시작 (메모리): ${receivedMetadata.filename} (0%)`;
                    }
                } else {
                    console.log('Filesystem Access API 미지원 또는 제한됨. 메모리 방식으로 수신.');
                    receiveStatus.textContent = `파일 수신 시작 (메모리): ${receivedMetadata.filename} (0%)`;
                }

                console.log('파일 메타데이터 수신:', receivedMetadata);

            } catch (e) {
                console.error('수신된 메타데이터 파싱 오류:', event.data, e);
                receiveStatus.textContent = '메타데이터 수신 오류.';
            }
        }
    } else { // 메시지가 ArrayBuffer면 파일 청크 데이터
        if (receivedMetadata) { // 메타데이터가 있어야 파일 청크로 처리
            receivedSize += event.data.byteLength;
            const percent = Math.floor((receivedSize / receivedMetadata.filesize) * 100);
            receiveStatus.textContent = `파일 수신 중: ${receivedMetadata.filename} (${percent}%)`;

            if (writableStream) { // 파일 스트림이 있으면 바로 디스크에 쓰기
                try {
                    await writableStream.write(event.data);
                } catch (err) {
                    console.error('파일 스트림 쓰기 오류:', err);
                    // 오류 발생 시 스트림 닫고 폴백 (남은 데이터를 메모리에 임시 저장 시도)
                    try { await writableStream.close(); } catch (closeErr) { console.error("Error closing stream after write error:", closeErr); }
                    writableStream = null;
                    fileHandle = null;
                    receiveStatus.textContent = '파일 쓰기 중 오류 발생. 남은 데이터를 메모리로 수신합니다.';
                    receivedFileBuffers.push(event.data); 
                }
            } else { // 파일 스트림이 없으면 메모리에 버퍼링
                receivedFileBuffers.push(event.data);
            }
        } else {
            console.warn('메타데이터 없이 파일 청크 수신됨, 무시합니다.');
        }
    }
}

/**
 * 수신 관련 스트림 및 버퍼를 초기화하고 닫습니다.
 */
async function closeFileStreamsAndClearReceiveState() {
    receivedFileBuffers = [];
    receivedMetadata = null;
    receivedSize = 0;
    if (writableStream) {
        try {
            await writableStream.close(); // 스트림을 닫아줘야 파일이 최종적으로 디스크에 저장됩니다.
            console.log("Writable stream closed.");
        } catch (e) {
            console.error("Error closing writable stream:", e);
        }
        writableStream = null;
    }
    fileHandle = null;
    receiveStatus.textContent = '파일 수신 대기 중...';
}
// ===========================================================================
