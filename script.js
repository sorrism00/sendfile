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
const downloadAllBtn = document.getElementById('downloadAllBtn'); // <-- 새로 추가된 버튼
// ===========================================================================


// ====== WebRTC 관련 변수 ===================================================
let ws; // WebSocket 연결 객체
let peerConnection; // RTCPeerConnection 객체 (P2P 연결 담당)
let sendChannel; // 파일 송신용 RTCDataChannel
let receiveChannel; // 파일 수신용 RTCDataChannel

let fileQueue = []; // 전송 대기 중인 파일 큐
let currentSendingFile = null; // 현재 전송 중인 파일 객체
let currentFileReader = null; // 현재 전송 중인 파일을 읽는 FileReader 객체

// 수신 측에서 여러 파일을 동시에 처리하기 위한 임시 저장 공간 (파일 ID로 관리)
// {fileId: {metadata, buffers:[], currentSize:0, receiveStatusElem, downloadBtn, blobUrl}}
const incomingFiles = new Map(); 

// 현재 처리 중인 수신 파일 ID.
let currentReceivingFileId = null; 
// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();

    connectBtn.addEventListener('click', createPeerConnectionAndOffer);
    fileInput.addEventListener('change', handleFileSelection);          // 파일 선택 핸들러 (multiple)
    sendFileBtn.addEventListener('click', processFileQueue);             // 큐에 있는 파일 전송 시작/상태 표시 버튼
    downloadAllBtn.addEventListener('click', downloadAllFilesAsZip);   // <-- 일괄 다운로드 버튼 이벤트

    updateSendFileButtonState();
    updateDownloadAllButtonState(); // <-- 새로 추가된 버튼 상태 업데이트
});

/**
 * UI 버튼들의 활성화/비활성화 상태를 업데이트합니다.
 * P2P 연결 상태와 파일 큐 상태에 따라 버튼 상태가 변경됩니다.
 */
function updateSendFileButtonState() {
    const isConnected = peerConnection && peerConnection.connectionState === 'connected';
    const hasFilesToProcess = currentSendingFile || fileQueue.length > 0;

    sendFileBtn.disabled = !(isConnected && hasFilesToProcess);
    
    if (currentSendingFile) {
        sendFileBtn.textContent = `전송 중: ${currentSendingFile.name} (${fileQueue.length}개 남음)`;
    } else if (fileQueue.length > 0) {
        sendFileBtn.textContent = `전송 시작 (${fileQueue.length}개 대기)`;
    } else {
        sendFileBtn.textContent = '파일 전송';
    }

    const isPeerConnectionActive = peerConnection && peerConnection.connectionState !== 'closed';
    connectBtn.disabled = isPeerConnectionActive;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectBtn.disabled = false;
    }
}

/**
 * 일괄 다운로드 버튼의 활성화/비활성화 상태를 업데이트합니다.
 */
function updateDownloadAllButtonState() {
    // 모든 수신 완료된 파일이 Map에 있고, 현재 다운로드 중이 아니라면 활성화
    // 여기서는 간단하게 incomingFiles 맵에 데이터가 있다면 활성화
    downloadAllBtn.disabled = incomingFiles.size === 0;
    
    // 만약 모든 파일의 수신이 완료되었는지 확인하고 싶다면
    // let allReceived = true;
    // if (incomingFiles.size === 0) allReceived = false;
    // for (const fileData of incomingFiles.values()) {
    //     if (!fileData.isComplete) { // fileData에 isComplete 플래그 추가 필요
    //         allReceived = false;
    //         break;
    //     }
    // }
    // downloadAllBtn.disabled = !allReceived;
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

    peerConnection.ondatachannel = event => {
        console.log('상대방으로부터 DataChannel 수신:', event.channel.label);
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

    closeAllFileStreamsAndClearReceiveState(); 
    receivedFilesList.innerHTML = ''; 

    sendFileStatus.textContent = '전송할 파일을 선택해 주세요.';
    receiveStatus.textContent = '파일 수신 대기 중...';
    updateSendFileButtonState(); 
    updateDownloadAllButtonState(); // 추가: 초기화 시 버튼도 업데이트
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
            processFileQueue(); 
        }
    };
    channel.onclose = () => {
        console.log('송신 DataChannel 닫힘!');
        updateSendFileButtonState();
        sendFileStatus.textContent = '파일 전송 채널 닫힘.';
        currentSendingFile = null; 
        currentFileReader = null;
        processFileQueue(); 
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
        } else if (fileQueue.length > 0) { 
            processFileQueue();
        }
    };
}

/**
 * 파일 전송 큐를 처리하여 다음 파일을 전송합니다.
 */
function processFileQueue() {
    if (!currentSendingFile && fileQueue.length > 0 && sendChannel && sendChannel.readyState === 'open') {
        currentSendingFile = fileQueue.shift(); 
        currentSendingFile._offset = 0; 
        currentSendingFile._fileId = Date.now() + '-' + Math.random().toString(36).substring(2, 9); // 파일별 고유 ID 부여

        sendFileStatus.textContent = `파일 전송 시작: ${currentSendingFile.name} (${(currentSendingFile.size / (1024 * 1024)).toFixed(2)} MB)`;
        
        currentFileReader = new FileReader(); 

        currentFileReader.onprogress = (e) => {
            const percent = Math.floor((currentSendingFile._offset / currentSendingFile.size) * 100);
            sendFileStatus.textContent = `전송 중: ${currentSendingFile.name} (${percent}%)`;
        };

        currentFileReader.onload = (e) => {
            sendChannel.send(e.target.result); // ArrayBuffer를 직접 전송
            currentSendingFile._offset += e.target.result.byteLength;
            
            attemptToSendNextChunk(currentSendingFile); 
        };

        currentFileReader.onerror = (e) => {
            console.error('파일 읽기 오류:', e);
            sendFileStatus.textContent = `파일 읽기 중 오류 발생: ${currentSendingFile.name}`;
            currentSendingFile = null; 
            currentFileReader = null;
            processFileQueue(); 
            updateSendFileButtonState();
        };

        sendChannel.binaryType = 'arraybuffer'; 
        attemptToSendNextChunk(currentSendingFile); 
        
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
    
    if (sendChannel.bufferedAmount > sendChannel.bufferedAmountLowThreshold) {
        console.log('DataChannel 버퍼 가득 참. 전송 일시 중지. bufferedAmount:', sendChannel.bufferedAmount);
        return; 
    }

    if (file._offset < file.size) {
        const slice = file.slice(file._offset, file._offset + CHUNK_SIZE);
        currentFileReader.readAsArrayBuffer(slice); 
    } else {
        sendFileStatus.textContent = `파일 전송 완료: ${file.name}`;
        sendChannel.send('EOM:' + file._fileId); 
        
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
    // 메시지가 문자열이면 메타데이터 또는 EOM 신호
    if (typeof event.data === 'string') {
        if (event.data.startsWith('EOM:')) { 
            const fileId = event.data.substring(4);
            const fileData = incomingFiles.get(fileId);

            if (fileData && fileData.metadata) {
                // Ensure all pending writes are complete before finalizing
                await writeAllPendingDataToStream(fileId); // 모든 버퍼링된 데이터 스트림에 쓰기

                if (fileData.writableStream) { // Filesystem Access API 사용 중이었다면
                    try {
                        await fileData.writableStream.close(); 
                        console.log(`스트림 최종 종료 성공: ${fileData.metadata.filename}`);
                        fileData.receiveStatusElem.textContent = '수신 완료';
                        fileData.saveBtn.textContent = '디스크 저장 완료';
                        fileData.saveBtn.style.backgroundColor = '#28a745'; 
                        fileData.saveBtn.disabled = true;
                    } catch (e) {
                        console.error('파일 스트림 닫기 오류 발생 (0KB 문제 유력 원인):', e);
                        fileData.receiveStatusElem.textContent = `오류: 디스크 저장 실패 (${e.message})`;
                        // 스트림 닫기 실패 시 Blob으로 폴백하여 다운로드 버튼 제공
                        tryFallbackToBlobDownload(fileId, fileData);
                    } finally {
                        incomingFiles.delete(fileId); 
                    }
                } else { // Blob으로 저장된 경우 (Filesystem Access API 미사용/실패)
                    const receivedBlob = new Blob(fileData.buffers, { type: fileData.metadata.filetype });
                    
                    if (receivedBlob.size === 0 && fileData.metadata.filesize > 0) {
                        console.error(`Blob 생성 오류: 수신된 파일 ${fileData.metadata.filename}이 0KB 입니다.`);
                        fileData.receiveStatusElem.textContent = `오류: 파일 0KB`;
                        fileData.saveBtn.textContent = '다운로드 불가';
                        fileData.saveBtn.style.backgroundColor = '#dc3545'; 
                        fileData.saveBtn.disabled = true;
                    } else {
                        const url = URL.createObjectURL(receivedBlob);
                        fileData.blobUrl = url; 
                        fileData.saveBtn.href = url;
                        fileData.saveBtn.setAttribute('download', fileData.metadata.filename);
                        fileData.saveBtn.textContent = '다운로드';
                        fileData.saveBtn.style.backgroundColor = '#4CAF50'; 
                        fileData.saveBtn.disabled = false; 
                        console.log(`파일 ${fileData.metadata.filename} Blob URL 생성: ${url}`);
                    }
                    incomingFiles.delete(fileId); 
                }
            } else {
                console.warn(`알 수 없는 파일 ID (${fileId})에 대한 EOM 신호 수신됨. incomingFiles Map:`, incomingFiles);
            }
            if (currentReceivingFileId === fileId) { // 현재 메타데이터를 받은 파일의 ID 초기화
                currentReceivingFileId = null;
            }
            updateDownloadAllButtonState(); // 모든 파일 수신 완료 상태에 따라 일괄 다운로드 버튼 업데이트

        } else { // 파일 메타데이터 수신 (JSON 문자열)
            try {
                const metadata = JSON.parse(event.data);
                const fileId = metadata.fileId; 

                // 이전 파일 수신 중이었다면 정리 (EOM이 누락되었을 경우 대비)
                if (currentReceivingFileId && incomingFiles.has(currentReceivingFileId)) {
                     console.warn(`이전 파일 (${incomingFiles.get(currentReceivingFileId).metadata.filename}) EOM 없이 다음 파일 메타데이터 수신. 이전 파일 정리.`);
                     await closeSingleFileStreamAndClearReceiveState(currentReceivingFileId);
                }

                // 새 파일에 대한 임시 저장소 및 UI 생성 (새로운 LI 요소 생성)
                const li = document.createElement('li');
                li.id = `received-file-${fileId}`; 
                li.innerHTML = `
                    <span>${metadata.filename} (${(metadata.filesize / (1024 * 1024)).toFixed(2)} MB)</span>
                    <span id="receive-status-${fileId}" class="status-badge">수신 시작 (0%)</span>
                    <a href="#" id="save-btn-${fileId}" class="btn" style="background-color:#5bc0de;" disabled>준비 중</a>
                `;
                receivedFilesList.appendChild(li); 

                const receiveStatusElem = li.querySelector(`#receive-status-${fileId}`);
                const saveBtn = li.querySelector(`#save-btn-${fileId}`);

                const fileData = {
                    metadata,
                    buffers: [], 
                    currentSize: 0,
                    receiveStatusElem,
                    saveBtn,
                    fileHandle: null,
                    writableStream: null,
                    blobUrl: null,
                    pendingWrites: [] 
                };
                incomingFiles.set(fileId, fileData); // Map에 파일 ID와 함께 저장
                currentReceivingFileId = fileId; // 현재 메타데이터를 받은 파일의 ID를 기록 (청크 처리용)

                receiveStatusElem.textContent = `수신 시작: ${metadata.filename} (0%)`;
                console.log('파일 메타데이터 수신:', metadata.filename);

                // Filesystem Access API는 사용자의 직접적인 클릭 제스처가 있어야 가능합니다.
                if ('showSaveFilePicker' in window && 'FileSystemWritableFileStream' in window) {
                    saveBtn.textContent = '디스크 저장';
                    saveBtn.style.backgroundColor = '#28a745'; 
                    saveBtn.disabled = false; 
                    saveBtn.onclick = async (e) => { // 버튼 클릭 시 스트림 생성 시도 (사용자 제스처)
                        e.preventDefault(); 
                        saveBtn.textContent = '저장 중...';
                        saveBtn.disabled = true;

                        try {
                            fileData.fileHandle = await window.showSaveFilePicker({
                                suggestedName: metadata.filename,
                                types: [{
                                    description: 'File to save',
                                    accept: { [metadata.filetype]: ['.' + (metadata.filename.split('.').pop() || 'dat')] }
                                }]
                            });
                            fileData.writableStream = await fileData.fileHandle.createWritable();
                            receiveStatusElem.textContent = `${metadata.filename} (디스크 스트림 활성화)`;
                            console.log('FilesystemWritableFileStream 생성됨 (사용자 제스처).');

                            // 이전에 메모리에 버퍼링된 데이터가 있다면 스트림에 쓰기
                            if (fileData.buffers.length > 0) {
                                console.log('버퍼링된 데이터 스트림에 쓰기 시작');
                                for (const buffer of fileData.buffers) {
                                    fileData.pendingWrites.push(fileData.writableStream.write(buffer));
                                }
                                fileData.buffers = []; 
                                console.log('버퍼링된 데이터 스트림에 쓰기 완료 (pendingWrites에 추가).');
                            }
                        } catch (err) {
                            console.warn('Filesystem Access API 사용 거부 또는 오류 (사용자 제스처 내):', err);
                            fileData.fileHandle = null;
                            fileData.writableStream = null;
                            receiveStatusElem.textContent = `${metadata.filename} (메모리 버퍼링 폴백)`;
                            saveBtn.textContent = '다운로드 준비'; 
                            saveBtn.style.backgroundColor = '#5bc0de'; 
                            saveBtn.onclick = null; 
                        }
                    };
                } else {
                    console.log('Filesystem Access API 미지원 또는 제한됨. 메모리 방식으로 수신.');
                    receiveStatusElem.textContent = `${metadata.filename} (메모리 버퍼링)`;
                }
            } catch (e) {
                console.error('수신된 메타데이터 파싱 오류:', event.data, e);
                receiveStatus.textContent = '메타데이터 수신 오류.';
            }
        }
    } else if (event.data instanceof ArrayBuffer) { // ArrayBuffer는 파일 청크 데이터입니다.
        if (!currentReceivingFileId || !incomingFiles.has(currentReceivingFileId)) {
            console.warn('현재 메타데이터가 없는 파일 청크 수신됨 또는 currentReceivingFileId 불일치. 해당 청크 무시.', currentReceivingFileId);
            return;
        }
        
        const fileData = incomingFiles.get(currentReceivingFileId); 

        // 데이터 크기 불일치 예방 (청크 과도 수신 방지)
        if (fileData.currentSize + event.data.byteLength > fileData.metadata.filesize + CHUNK_SIZE * 5) { 
             console.error(`수신 데이터 크기 불일치 오류. 파일 ${fileData.metadata.filename} 전송 중단.`);
             fileData.receiveStatusElem.textContent = `오류: 데이터 크기 불일치!`;
             fileData.saveBtn.disabled = true;
             await closeSingleFileStreamAndClearReceiveState(currentReceivingFileId); 
             return;
        }

        fileData.currentSize += event.data.byteLength;
        const percent = Math.floor((fileData.currentSize / fileData.metadata.filesize) * 100);
        fileData.receiveStatusElem.textContent = `${fileData.metadata.filename} (${percent}%)`;

        if (fileData.writableStream) { 
            try {
                fileData.pendingWrites.push(fileData.writableStream.write(event.data)); // write 작업의 Promise를 pendingWrites 배열에 추가
            } catch (err) {
                console.error('파일 스트림 쓰기 오류:', err);
                try { await fileData.writableStream.close(); } catch (closeErr) { console.error("Error closing stream after write error:", closeErr); }
                fileData.writableStream = null;
                fileData.fileHandle = null;
                fileData.receiveStatusElem.textContent = '파일 쓰기 중 오류 발생. 메모리로 수신합니다.';
                fileData.buffers.push(event.data); 
                fileData.saveBtn.textContent = '다운로드 준비';
                fileData.saveBtn.style.backgroundColor = '#5bc0de'; 
                fileData.saveBtn.onclick = null; 
            }
        } else { 
            fileData.buffers.push(event.data);
            if (fileData.currentSize > DATA_CHANNEL_BUFFER_THRESHOLD * 2 && !fileData.warnedMemory) { 
                console.warn(`파일 ${fileData.metadata.filename}이 대용량이며 메모리에 버퍼링 중입니다. 브라우저 성능에 영향을 줄 수 있습니다.`);
                fileData.warnedMemory = true; 
            }
        }
    }
}

/**
 * FileSystemWritableFileStream에 모든 버퍼링된 데이터를 쓰고 완료될 때까지 기다립니다.
 * @param {string} fileId - 대상 파일의 ID
 */
async function writeAllPendingDataToStream(fileId) {
    const fileData = incomingFiles.get(fileId);
    if (!fileData || !fileData.writableStream) {
        return; 
    }
    // 남아있는 pendingWrites를 모두 기다린 후 비웁니다.
    if (fileData.pendingWrites.length > 0) {
        console.log(`파일 ${fileData.metadata.filename}: ${fileData.pendingWrites.length}개의 pending writes 대기 중...`);
        try {
            await Promise.all(fileData.pendingWrites); 
            fileData.pendingWrites = []; 
            console.log(`파일 ${fileData.metadata.filename}: 모든 pending writes 완료.`);
        } catch (e) {
            console.error(`파일 ${fileData.metadata.filename}: pending writes 중 오류 발생:`, e);
        }
    }
}

/**
 * 디스크 스트림 닫기 실패 시 Blob 다운로드로 폴백 처리합니다.
 * @param {string} fileId - 대상 파일 ID
 * @param {object} fileData - 해당 파일의 데이터 객체
 */
function tryFallbackToBlobDownload(fileId, fileData) {
    const receivedBlob = new Blob(fileData.buffers, { type: fileData.metadata.filetype });
    if (receivedBlob.size === 0 && fileData.metadata.filesize > 0) {
        console.error(`Blob 생성 실패 또는 0KB. 파일 ${fileData.metadata.filename}`);
        fileData.receiveStatusElem.textContent = `오류: 파일 0KB/다운로드 불가`;
        fileData.saveBtn.textContent = '실패';
        fileData.saveBtn.style.backgroundColor = '#dc3545';
        fileData.saveBtn.disabled = true;
    } else {
        const url = URL.createObjectURL(receivedBlob);
        fileData.blobUrl = url; 
        fileData.saveBtn.href = url;
        fileData.saveBtn.setAttribute('download', fileData.metadata.filename);
        fileData.saveBtn.textContent = '다운로드 (폴백)';
        fileData.saveBtn.style.backgroundColor = '#ffc107'; // 경고색으로 변경
        fileData.saveBtn.disabled = false; 
        console.log(`파일 ${fileData.metadata.filename} Blob 다운로드로 폴백.`);
    }
}

// =========================================================================================
// ====== 일괄 다운로드 기능 추가 =============================================================
// =========================================================================================

/**
 * 모든 수신 완료된 파일을 ZIP 파일로 묶어서 다운로드합니다.
 */
async function downloadAllFilesAsZip() {
    if (incomingFiles.size === 0) {
        alert('다운로드할 파일이 없습니다.');
        return;
    }

    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = '압축 중...';

    try {
        const zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));

        // 모든 수신 완료된 파일들을 순회하며 ZIP 파일에 추가
        for (const fileData of incomingFiles.values()) {
            if (!fileData.blobUrl) { // Filesystem API로 저장되었거나 아직 Blob URL이 생성되지 않은 경우
                 console.warn(`파일 ${fileData.metadata.filename}은 Blob URL이 없어 ZIP에 추가할 수 없습니다.`);
                 continue; // 건너뛰기
            }

            // Blob URL에서 Blob을 가져와 ZIP에 추가 (필요시 fetch로 Blob URL을 다시 가져올 수 있음)
            const fileBlob = await (await fetch(fileData.blobUrl)).blob();

            await zipWriter.add(fileData.metadata.filename, new zip.BlobReader(fileBlob));
            console.log(`파일 ${fileData.metadata.filename}이 ZIP에 추가되었습니다.`);
        }

        const zipBlob = await zipWriter.close();
        const zipUrl = URL.createObjectURL(zipBlob);

        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = 'sendfile_downloads.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(zipUrl); // ZIP Blob URL 해제
        alert('모든 파일이 "sendfile_downloads.zip"으로 다운로드됩니다.');

    } catch (e) {
        console.error('일괄 다운로드 (ZIP) 중 오류 발생:', e);
        alert('일괄 다운로드 중 오류가 발생했습니다. 자세한 내용은 콘솔을 확인해 주세요.');
    } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.textContent = '일괄 다운로드 (.zip)';
    }
}


/**
 * 모든 수신 관련 스트림 및 버퍼를 초기화하고 닫습니다. (전체 incomingFiles 맵 정리)
 */
async function closeAllFileStreamsAndClearReceiveState() {
    for (const [fileId, fileData] of incomingFiles.entries()) {
        if (fileData.writableStream) {
            try { 
                await writeAllPendingDataToStream(fileId); 
                await fileData.writableStream.close(); 
            } catch (e) { console.error("Error closing writable stream on clear:", e); }
        }
        if (fileData.blobUrl) { // URL.revokeObjectURL 호출
            URL.revokeObjectURL(fileData.blobUrl);
        }
        const liElem = document.getElementById(`received-file-${fileId}`);
        if (liElem) liElem.remove(); 
    }
    incomingFiles.clear(); 
    currentReceivingFileId = null; 

    receiveStatus.textContent = '파일 수신 대기 중...';
    updateDownloadAllButtonState(); // 일괄 다운로드 버튼 상태 업데이트
}

/**
 * 특정 파일 ID에 해당하는 수신 스트림/버퍼를 초기화하고 닫습니다.
 * @param {string} fileId - 정리할 파일의 고유 ID
 */
async function closeSingleFileStreamAndClearReceiveState(fileId) {
    const fileData = incomingFiles.get(fileId);
    if (fileData) {
        if (fileData.writableStream) {
            try { 
                await writeAllPendingDataToStream(fileId); 
                await fileData.writableStream.close(); 
            } catch (e) { console.error("Error closing writable stream for single file:", e); }
        }
        if (fileData.blobUrl) { // URL.revokeObjectURL 호출
            URL.revokeObjectURL(fileData.blobUrl);
        }
        const liElem = document.getElementById(`received-file-${fileId}`);
        if (liElem) liElem.remove();
        incomingFiles.delete(fileId);
        if (currentReceivingFileId === fileId) {
            currentReceivingFileId = null; 
        }
        updateDownloadAllButtonState(); // 개별 파일 삭제 시 일괄 다운로드 버튼 상태 업데이트
    }
}
// ===========================================================================
