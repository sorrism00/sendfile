// ====== 설정 영역 ==========================================================
// Railway 시그널링 서버의 실제 URL로 변경해야 합니다.
// 예: 'wss://your-sendfile-signaling-server-abcd.up.railway.app'
const RAILWAY_SIGNALING_SERVER_URL = 'wss://sendfile-signaling-server-production.up.railway.app'; 
const STUN_SERVER_URL = 'stun:stun.l.google.com:19302'; // Google의 공개 STUN 서버
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

// 수신 측에서 여러 파일을 동시에 처리하기 위한 임시 저장 공간
const incomingFiles = new Map(); // {fileId: {metadata, buffers, size, fileHandle, writableStream}}

// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();

    connectBtn.addEventListener('click', createPeerConnectionAndOffer);
    fileInput.addEventListener('change', handleFileSelection);          // 파일 선택 핸들러 (multiple)
    sendFileBtn.addEventListener('click', processFileQueue);             // 큐에 있는 파일 전송 시작/상태 표시 버튼

    updateSendFileButtonState();
});

/**
 * UI 버튼들의 활성화/비활성화 상태를 업데이트합니다.
 * P2P 연결 상태와 파일 큐 상태에 따라 버튼 상태가 변경됩니다.
 */
function updateSendFileButtonState() {
    const isConnected = peerConnection && peerConnection.connectionState === 'connected';
    const hasFilesToProcess = currentSendingFile || fileQueue.length > 0;

    // "파일 전송" 버튼 활성화 조건: P2P 연결 완료 AND (전송 중인 파일 있거나 큐에 파일 있음)
    sendFileBtn.disabled = !(isConnected && hasFilesToProcess);
    
    // 버튼 텍스트 업데이트
    if (currentSendingFile) {
        sendFileBtn.textContent = `전송 중: ${currentSendingFile.name} (${fileQueue.length}개 남음)`;
    } else if (fileQueue.length > 0) {
        sendFileBtn.textContent = `전송 시작 (${fileQueue.length}개 대기)`;
    } else {
        sendFileBtn.textContent = '파일 전송'; // 큐에 아무것도 없으면 원래 텍스트
    }

    // "연결 시작" 버튼 활성화/비활성화
    const isPeerConnectionActive = peerConnection && peerConnection.connectionState !== 'closed';
    connectBtn.disabled = isPeerConnectionActive;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectBtn.disabled = false;
    }
}

/**
 * 파일 선택 입력창에서 파일 선택 시 호출되는 핸들러.
 * 선택된 파일을 전송 큐에 추가합니다.
 */
function handleFileSelection() {
    const selectedFiles = Array.from(fileInput.files);
    if (selectedFiles.length > 0) {
        fileQueue.push(...selectedFiles); // 선택된 모든 파일을 큐에 추가
        fileInput.value = ''; // 파일 입력 필드 초기화 (다음에 같은 파일을 선택할 수 있도록)
        sendFileStatus.textContent = `${selectedFiles.length}개의 파일이 큐에 추가되었습니다. 총 ${fileQueue.length}개 대기 중.`;
        
        // DataChannel이 열려있고, 현재 전송 중인 파일이 없다면 새 파일 전송 시작
        if (!currentSendingFile && sendChannel && sendChannel.readyState === 'open') {
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
            return; 
        }

        if (!peerConnection || peerConnection.connectionState === 'closed') { 
            createPeerConnection();
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
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)); 
            } catch (e) {
                console.error('ICE candidate 추가 실패:', e, message.candidate);
            }
        }
    };

    ws.onclose = () => {
        console.log('시그널링 서버 연결이 끊어졌습니다.');
        connectionStatus.textContent = '연결 상태: 시그널링 서버 연결 끊김';
        
        closePeerConnectionAndClearQueues();
        updateSendFileButtonState();
    };

    ws.onerror = error => {
        console.error('WebSocket 오류 발생:', error);
        connectionStatus.textContent = '연결 상태: 시그널링 서버 오류 발생';
        
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
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        peerConnection.close();
    }

    const configuration = {
        iceServers: [{ urls: STUN_SERVER_URL }] // STUN 서버 설정
    };
    peerConnection = new RTCPeerConnection(configuration);

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            console.log('ICE candidate 전송:', event.candidate.candidate);
            ws.send(JSON.stringify({
                type: 'candidate', 
                candidate: event.candidate 
            }));
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC 연결 상태:', peerConnection.connectionState);
        connectionStatus.textContent = `연결 상태: ${peerConnection.connectionState}`;
        updateSendFileButtonState(); 

        if (peerConnection.connectionState === 'connected') {
            // P2P 연결 완료 시, 전송 대기 중인 파일이 있다면 전송 시작
            if (fileQueue.length > 0 && !currentSendingFile) {
                processFileQueue();
            }
        }
    };

    // NOTE: DataChannel은 한 번의 PeerConnection 내에서 여러 개 생성될 수 있습니다.
    // 하지만 파일 전송 앱의 단순성을 위해, 'fileTransfer'라는 단일 채널만 사용할 것을 가정합니다.
    peerConnection.ondatachannel = event => {
        console.log('상대방으로부터 DataChannel 수신:', event.label);
        // 이미 receiveChannel이 있다면 기존 채널을 닫고 새 채널 사용 (간단한 구현을 위해)
        // 실제로는 채널 이름(event.label)을 통해 여러 채널을 동시에 관리할 수 있습니다.
        if (receiveChannel && receiveChannel.readyState !== 'closed') {
            receiveChannel.close();
        }
        receiveChannel = event.channel;
        setupReceiveChannel(receiveChannel);
    };
}

/**
 * "연결 시작" 버튼 클릭 시 실행됩니다.
 * PeerConnection을 생성하고 Offer를 생성하여 시그널링 서버로 전송합니다.
 */
async function createPeerConnectionAndOffer() {
    if (peerConnection && peerConnection.connectionState !== 'closed') {
        console.log('이미 PeerConnection이 존재하거나 연결 시도 중입니다. 재연결을 시도하지 않습니다.');
        return;
    }

    if (!ws || ws.readyState === WebSocket.CLOSED) {
        console.log('WebSocket이 연결되어 있지 않습니다. 먼저 시그널링 서버에 연결을 시도합니다.');
        connectWebSocket();
    }
    
    if (ws.readyState !== WebSocket.OPEN) {
        console.log('WebSocket 연결 대기 중... 1초 후 다시 시도합니다.');
        setTimeout(createPeerConnectionAndOffer, 1000); 
        return;
    }

    createPeerConnection();

    sendChannel = peerConnection.createDataChannel('fileTransfer'); 
    setupSendChannel(sendChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    ws.send(JSON.stringify({ type: offer.type, sdp: offer.sdp })); 
    
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

    fileQueue = []; 
    currentSendingFile = null; 
    currentFileReader = null; 

    // 수신 측에서 모든 임시 파일 스트림/버퍼 정리
    for (const [fileId, fileData] of incomingFiles.entries()) {
        if (fileData.writableStream) {
            try { fileData.writableStream.close(); } catch (e) { console.error("Error closing stream:", e); }
        }
        URL.revokeObjectURL(fileData.blobUrl); // 혹시 Blob URL이 남아있다면 해제
        incomingFiles.delete(fileId);
    }
    receivedFilesList.innerHTML = ''; // 수신 목록 UI 초기화 (선택 사항, 이전 목록 유지하려면 주석 처리)

    sendFileStatus.textContent = '전송할 파일을 선택해 주세요.';
    receiveStatus.textContent = '파일 수신 대기 중...';
    updateSendFileButtonState(); // 상태 변경 시 버튼도 업데이트
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
        sendFileStatus.textContent = `파일 전송 준비 완료. ${fileQueue.length}개의 파일 대기 중.`;
        if (fileQueue.length > 0 && !currentSendingFile) {
            processFileQueue(); // DataChannel이 열리면 큐 처리 시작
        }
    };
    channel.onclose = () => {
        console.log('송신 DataChannel 닫힘!');
        updateSendFileButtonState();
        sendFileStatus.textContent = '파일 전송 채널 닫힘.';
        currentSendingFile = null; 
        currentFileReader = null;
        processFileQueue(); // 채널 닫히면 다음 파일 처리 시도 (DataChannel이 새로 생성될 경우 대비)
    };
    channel.onerror = error => {
        console.error('송신 DataChannel 오류:', error);
        sendFileStatus.textContent = `파일 전송 채널 오류: ${error.message}`;
        currentSendingFile = null; 
        currentFileReader = null;
        processFileQueue(); 
        updateSendFileButtonState();
    };

    channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_THRESHOLD; 
    channel.onbufferedamountlow = () => {
        console.log('bufferedAmountLow 이벤트 발생. 데이터 전송 재개 시도. bufferedAmount:', channel.bufferedAmount);
        if (currentSendingFile) {
            attemptToSendNextChunk(currentSendingFile);
        } else if (fileQueue.length > 0) { // 현재 전송 중인 파일이 없는데 큐에 있다면 다음 파일 시작
            processFileQueue();
        }
    };
}

/**
 * 파일 전송 큐를 처리하여 다음 파일을 전송합니다.
 */
function processFileQueue() {
    if (!currentSendingFile && fileQueue.length > 0 && sendChannel && sendChannel.readyState === 'open') {
        currentSendingFile = fileQueue.shift(); // 큐에서 다음 파일 가져오기
        currentSendingFile._offset = 0; // 파일 객체에 현재 전송 위치 저장 (내부적으로)
        // 파일별 고유 ID를 부여하여 수신자 측에서 여러 파일을 구분할 수 있도록 합니다.
        currentSendingFile._fileId = Date.now() + '-' + Math.random().toString(36).substring(2, 9); 

        sendFileStatus.textContent = `파일 전송 시작: ${currentSendingFile.name} (${(currentSendingFile.size / (1024 * 1024)).toFixed(2)} MB)`;
        
        currentFileReader = new FileReader(); 

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
            currentSendingFile = null; 
            currentFileReader = null;
            processFileQueue(); 
            updateSendFileButtonState();
        };

        attemptToSendNextChunk(currentSendingFile); // 첫 청크 전송 시작 (메타데이터 포함)
        
    } else if (fileQueue.length === 0 && !currentSendingFile) {
        sendFileStatus.textContent = '전송할 파일이 없습니다.';
        updateSendFileButtonState();
    } else {
        updateSendFileButtonState(); 
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
        processFileQueue(); 
        updateSendFileButtonState();
        return;
    }

    // 파일 메타데이터 전송 (첫 청크 전송 직전)
    if (file._offset === 0) {
        const metadata = {
            fileId: file._fileId, // 고유 ID 포함
            filename: file.name,
            filesize: file.size,
            filetype: file.type
        };
        sendChannel.send(JSON.stringify(metadata));
        console.log('파일 메타데이터 전송:', metadata.filename);
    }
    
    // 버퍼가 임계값 초과하면 전송 일시 중지 (onbufferedamountlow 이벤트가 발생할 때까지 대기)
    if (sendChannel.bufferedAmount > sendChannel.bufferedAmountLowThreshold) {
        console.log('DataChannel 버퍼 가득 참. 전송 일시 중지. bufferedAmount:', sendChannel.bufferedAmount);
        return; 
    }

    if (file._offset < file.size) {
        const slice = file.slice(file._offset, file._offset + CHUNK_SIZE);
        currentFileReader.readAsArrayBuffer(slice); // 다음 청크 읽기 시작 (onload에서 sendChannel.send 호출)
    } else {
        sendFileStatus.textContent = `파일 전송 완료: ${file.name}`;
        sendChannel.send('EOM:' + file._fileId); // EOM 신호에 파일 ID 포함
        
        currentSendingFile = null; 
        currentFileReader = null; 
        console.log('모든 청크 전송 완료. 다음 파일 처리 시작.');
        processFileQueue(); 
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
        closeAllFileStreamsAndClearReceiveState(); 
    };
    channel.onerror = error => {
        console.error('수신 DataChannel 오류:', error);
        receiveStatus.textContent = `파일 수신 채널 오류: ${error.message}`;
        closeAllFileStreamsAndClearReceiveState(); 
    };

    channel.onmessage = handleReceiveMessage; 
}

/**
 * DataChannel을 통해 수신된 메시지를 처리합니다.
 * 파일 메타데이터 수신, 파일 청크 수신, 파일 전송 완료 신호 등을 처리합니다.
 * @param {MessageEvent} event - DataChannel로부터 수신된 메시지 이벤트 객체
 */
async function handleReceiveMessage(event) {
    if (typeof event.data === 'string') {
        // EOM 신호 처리 (파일 ID 포함)
        if (event.data.startsWith('EOM:')) {
            const fileId = event.data.substring(4);
            const fileData = incomingFiles.get(fileId);

            if (fileData && fileData.metadata) {
                fileData.receiveStatusElem.textContent = `파일 수신 완료: ${fileData.metadata.filename}`;
                console.log(`파일 수신 완료: ${fileData.metadata.filename}`);

                if (fileData.writableStream) { // FileSystem Access API 사용 중이었다면
                    try {
                        await fileData.writableStream.close();
                        console.log(`스트림 종료: ${fileData.metadata.filename}`);
                        fileData.saveBtn.textContent = '저장됨';
                        fileData.saveBtn.disabled = true;
                    } catch (e) {
                        console.error('파일 스트림 닫기 오류:', e);
                        fileData.receiveStatusElem.textContent = `수신 오류 (스트림 닫기 실패): ${e.message}`;
                    }
                } else { // Blob으로 저장된 경우
                    const receivedBlob = new Blob(fileData.buffers, { type: fileData.metadata.filetype });
                    const url = URL.createObjectURL(receivedBlob);
                    fileData.blobUrl = url; // 나중에 해제를 위해 URL 저장
                    fileData.saveBtn.href = url;
                    fileData.saveBtn.setAttribute('download', fileData.metadata.filename);
                    fileData.saveBtn.textContent = '다운로드';
                    fileData.saveBtn.disabled = false;
                }
                // 이 파일에 대한 임시 데이터 정리
                incomingFiles.delete(fileId); 
            } else {
                console.warn(`알 수 없는 파일 ID (${fileId})에 대한 EOM 신호 수신됨.`);
            }
        } else { // 파일 메타데이터 수신 (JSON 문자열)
            try {
                const metadata = JSON.parse(event.data);
                const fileId = metadata.fileId;

                // 새 파일에 대한 임시 저장소 및 UI 생성
                const li = document.createElement('li');
                li.id = `received-file-${fileId}`; // 파일별 고유 ID
                li.innerHTML = `
                    <span>${metadata.filename} (${(metadata.filesize / (1024 * 1024)).toFixed(2)} MB)</span>
                    <span id="receive-status-${fileId}">수신 시작 (0%)</span>
                    <a href="#" id="save-btn-${fileId}" class="btn" style="background-color:#5bc0de;" disabled>준비 중</a>
                `;
                receivedFilesList.appendChild(li);

                const receiveStatusElem = li.querySelector(`#receive-status-${fileId}`);
                const saveBtn = li.querySelector(`#save-btn-${fileId}`);

                const fileData = {
                    metadata,
                    buffers: [], // Filesystem Access API 미지원 시 사용
                    currentSize: 0,
                    receiveStatusElem,
                    saveBtn,
                    fileHandle: null,
                    writableStream: null,
                    blobUrl: null // Blob URL 생성 시 저장
                };
                incomingFiles.set(fileId, fileData);

                receiveStatusElem.textContent = `수신 시작: ${metadata.filename} (0%)`;
                console.log('파일 메타데이터 수신:', metadata.filename);

                // FileSystem Access API 지원 여부 확인 및 사용 시도 (대용량 파일에 효과적)
                if ('showSaveFilePicker' in window && 'FileSystemWritableFileStream' in window) {
                     // saveBtn에 클릭 이벤트 리스너를 붙여 사용자 제스처 시 호출되도록 합니다.
                    saveBtn.textContent = '디스크 저장';
                    saveBtn.disabled = false; // 사용자 클릭 대기 상태
                    saveBtn.onclick = async (e) => {
                        e.preventDefault(); // 기본 링크 동작 방지
                        try {
                            fileData.fileHandle = await window.showSaveFilePicker({
                                suggestedName: metadata.filename,
                                types: [{
                                    description: 'File to save',
                                    accept: { [metadata.filetype]: ['.' + (metadata.filename.split('.').pop() || 'dat')] }
                                }]
                            });
                            fileData.writableStream = await fileData.fileHandle.createWritable();
                            receiveStatusElem.textContent = `${metadata.filename} (스트림 활성화 중)`;
                            saveBtn.textContent = '저장 중...';
                            saveBtn.disabled = true; // 저장 시작 후 비활성화
                            console.log('FilesystemWritableFileStream 생성됨.');

                            // 이전에 버퍼링된 데이터가 있다면 스트림에 쓰기
                            if (fileData.buffers.length > 0) {
                                console.log('버퍼링된 데이터 스트림에 쓰기 시작');
                                for (const buffer of fileData.buffers) {
                                    await fileData.writableStream.write(buffer);
                                }
                                fileData.buffers = []; // 버퍼 비움
                                console.log('버퍼링된 데이터 스트림에 쓰기 완료');
                            }
                        } catch (err) {
                            console.warn('Filesystem Access API 사용 거부 또는 오류:', err);
                            fileData.fileHandle = null;
                            fileData.writableStream = null;
                            receiveStatusElem.textContent = `${metadata.filename} (메모리 버퍼링)`;
                            saveBtn.textContent = '다운로드 준비'; // 다운로드 버튼으로 변경
                            // 이미 버퍼에 쌓인 데이터가 있으므로 Blob 생성 준비
                        }
                    };

                } else {
                    console.log('Filesystem Access API 미지원 또는 제한됨. 메모리 방식으로 수신.');
                    receiveStatusElem.textContent = `${metadata.filename} (메모리 버퍼링)`;
                    saveBtn.textContent = '다운로드 준비';
                    // 이 시점에서는 버튼을 즉시 활성화하지 않고 EOM 받은 후에 Blob URL 생성 후 활성화
                }
            } catch (e) {
                console.error('수신된 메타데이터 파싱 오류:', event.data, e);
                receiveStatus.textContent = '메타데이터 수신 오류.';
            }
        }
    } else { // 메시지가 ArrayBuffer면 파일 청크 데이터
        // 전송 중인 파일의 ID가 없거나 메타데이터가 없는 경우 무시
        if (!event.data || !receivedMetadata || !incomingFiles.has(receivedMetadata.fileId)) {
            console.warn('메타데이터/파일 ID 없이 청크 수신됨, 무시합니다.', receivedMetadata);
            return;
        }

        const fileData = incomingFiles.get(receivedMetadata.fileId);
        fileData.currentSize += event.data.byteLength;
        const percent = Math.floor((fileData.currentSize / fileData.metadata.filesize) * 100);
        fileData.receiveStatusElem.textContent = `${fileData.metadata.filename} (${percent}%)`;

        if (fileData.writableStream) { // 파일 스트림이 있으면 바로 디스크에 쓰기
            try {
                await fileData.writableStream.write(event.data);
            } catch (err) {
                console.error('파일 스트림 쓰기 오류:', err);
                try { await fileData.writableStream.close(); } catch (closeErr) { console.error("Error closing stream after write error:", closeErr); }
                fileData.writableStream = null;
                fileData.fileHandle = null;
                fileData.receiveStatusElem.textContent = '파일 쓰기 중 오류 발생. 남은 데이터를 메모리로 수신합니다.';
                fileData.buffers.push(event.data); // 남은 데이터는 메모리에 임시 저장 시도
                fileData.saveBtn.textContent = '다운로드 준비';
                fileData.saveBtn.disabled = false;
            }
        } else { // 파일 스트림이 없으면 메모리에 버퍼링
            fileData.buffers.push(event.data);
            // 만약 스트리밍 전환 가능하면 시도
            if (fileData.saveBtn.onclick && !fileData.writableStream && fileData.buffers.length > 0 && fileData.saveBtn.disabled === false) {
                 // 이 시점에서 스트림 버튼이 활성화되어 있고 사용자가 클릭하지 않았다면
                 // 이미 메모리에 데이터가 쌓이고 있으므로 이제 Blob 방식으로 처리한다고 가정하고, 
                 // 나중에 EOM 받았을 때 다운로드 버튼 활성화
            }
        }
    }
}

/**
 * 수신 관련 스트림 및 버퍼를 초기화하고 닫습니다. (전체 incomingFiles 정리)
 */
async function closeAllFileStreamsAndClearReceiveState() {
    for (const [fileId, fileData] of incomingFiles.entries()) {
        if (fileData.writableStream) {
            try { await fileData.writableStream.close(); } catch (e) { console.error("Error closing writable stream on clear:", e); }
        }
        if (fileData.blobUrl) {
            URL.revokeObjectURL(fileData.blobUrl);
        }
        // UI에서 해당 파일 항목 제거 (선택 사항)
        const liElem = document.getElementById(`received-file-${fileId}`);
        if (liElem) liElem.remove();
    }
    incomingFiles.clear(); // 맵 초기화

    receiveStatus.textContent = '파일 수신 대기 중...';
    // receivedFilesList.innerHTML = ''; // 필요한 경우 목록 초기화 (현재는 파일별로 정리되므로 불필요)
}
// ===========================================================================
