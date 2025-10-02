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
const sendingFilesList = document.getElementById('sendingFilesList'); // <-- 새로 추가된 목록
const receiveStatus = document.getElementById('receiveStatus');
const receivedFilesList = document.getElementById('receivedFilesList');
const downloadAllBtn = document.getElementById('downloadAllBtn'); 
// ===========================================================================


// ====== WebRTC 관련 변수 ===================================================
let ws; 
let peerConnection; 
let sendChannel; 
let receiveChannel; 

let fileQueue = []; // 전송 대기 중인 파일 큐
let currentSendingFile = null; // 현재 전송 중인 파일 객체
let currentFileReader = null; 

// {fileId: {metadata, buffers:[], currentSize:0, receiveStatusElem, downloadBtn, blobUrl, isComplete:false}}
const incomingFiles = new Map(); 

// 현재 청크를 처리할 파일의 ID. 메타데이터가 올 때 업데이트
let currentReceivingFileId = null; 

// 전송 측에서 전송 대기/진행 상태를 관리하기 위한 맵
// {fileId: {file:File, statusElem:HTMLElement, statusBadge:HTMLElement}}
const sendingFileStates = new Map();

// ===========================================================================


// ====== 초기화 및 이벤트 리스너 =============================================
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();

    connectBtn.addEventListener('click', createPeerConnectionAndOffer);
    fileInput.addEventListener('change', handleFileSelection);          // 파일 선택 핸들러 (multiple)
    sendFileBtn.addEventListener('click', processFileQueue);             // 큐에 있는 파일 전송 시작/상태 표시 버튼
    downloadAllBtn.addEventListener('click', downloadAllFilesAsZip);   // 일괄 다운로드 버튼 이벤트

    updateSendFileButtonState();
    updateDownloadAllButtonState(); 
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
 * 모든 수신된 파일이 `isComplete: true`이고 `blobUrl`을 가지고 있으면 활성화됩니다.
 */
function updateDownloadAllButtonState() {
    let allFilesComplete = true;
    if (incomingFiles.size === 0) {
        allFilesComplete = false;
    } else {
        for (const fileData of incomingFiles.values()) {
            if (!fileData.isComplete || !fileData.blobUrl) { 
                allFilesComplete = false;
                break;
            }
        }
    }
    downloadAllBtn.disabled = !allFilesComplete;
    if (!allFilesComplete) {
        downloadAllBtn.textContent = '일괄 다운로드 (.zip)';
    } else {
        downloadAllBtn.textContent = `일괄 다운로드 (${incomingFiles.size}개)`;
    }
}


/**
 * 파일 선택 입력창에서 파일 선택 시 호출되는 핸들러.
 * 선택된 파일을 전송 큐에 추가하고, 전송 목록 UI를 업데이트합니다.
 */
function handleFileSelection() {
    const selectedFiles = Array.from(fileInput.files);
    if (selectedFiles.length > 0) {
        fileQueue.push(...selectedFiles); 
        fileInput.value = ''; 
        sendFileStatus.textContent = `${selectedFiles.length}개의 파일이 큐에 추가되었습니다. 총 ${fileQueue.length}개 대기 중.`;
        
        // 전송 목록 UI 업데이트 (새로 추가된 파일)
        selectedFiles.forEach(file => {
            const fileId = Date.now() + '-' + Math.random().toString(36).substring(2, 9);
            file._fileId = fileId; // 파일 객체에 ID 부여
            const li = document.createElement('li');
            li.id = `sending-file-${fileId}`;
            li.innerHTML = `
                <span>${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)</span>
                <span id="send-status-${fileId}" class="status-badge pending">대기 중</span>
            `;
            sendingFilesList.appendChild(li);

            sendingFileStates.set(fileId, {
                file: file,
                statusElem: li.querySelector(`#send-status-${fileId}`)
            });
        });


        if (!currentSendingFile && sendChannel && sendChannel.readyState === 'open') {
            processFileQueue();
        }
    }
    updateSendFileButtonState(); 
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

    // 전송 목록 UI 초기화
    sendingFilesList.innerHTML = ''; 
    sendingFileStates.clear();

    closeAllFileStreamsAndClearReceiveState(); 
    receivedFilesList.innerHTML = ''; 

    sendFileStatus.textContent = '전송할 파일을 선택해 주세요.';
    receiveStatus.textContent = '파일 수신 대기 중...';
    updateSendFileButtonState(); 
    updateDownloadAllButtonState(); 
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
        // 오류 발생 시 전송 중이던 파일의 상태를 '오류'로 업데이트
        if (currentSendingFile && sendingFileStates.has(currentSendingFile._fileId)) {
            const state = sendingFileStates.get(currentSendingFile._fileId);
            state.statusElem.textContent = '전송 오류';
            state.statusElem.className = 'status-badge error';
        }
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

        // 전송 중인 파일의 UI 상태 업데이트
        if (sendingFileStates.has(currentSendingFile._fileId)) {
            const state = sendingFileStates.get(currentSendingFile._fileId);
            state.statusElem.textContent = '전송 중 (0%)';
            state.statusElem.className = 'status-badge sending';
        }

        sendFileStatus.textContent = `파일 전송 시작: ${currentSendingFile.name} (${(currentSendingFile.size / (1024 * 1024)).toFixed(2)} MB)`;
        
        currentFileReader = new FileReader(); 

        currentFileReader.onprogress = (e) => {
            const percent = Math.floor((currentSendingFile._offset / currentSendingFile.size) * 100);
            if (sendingFileStates.has(currentSendingFile._fileId)) {
                sendingFileStates.get(currentSendingFile._fileId).statusElem.textContent = `전송 중 (${percent}%)`;
            }
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
            // 파일 읽기 오류 발생 시 파일 상태 업데이트
            if (currentSendingFile && sendingFileStates.has(currentSendingFile._fileId)) {
                const state = sendingFileStates.get(currentSendingFile._fileId);
                state.statusElem.textContent = '읽기 오류';
                state.statusElem.className = 'status-badge error';
            }
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
        if (file && sendingFileStates.has(file._fileId)) {
            const state = sendingFileStates.get(file._fileId);
            state.statusElem.textContent = '연결 끊김';
            state.statusElem.className = 'status-badge error';
        }
        currentSendingFile = null;
        currentFileReader = null;
        processFileQueue(); 
        updateSendFileButtonState();
        return;
    }

    if (file._offset === 0) {
        const metadata = {
            fileId: file._fileId, 
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
        
        // 전송 완료 시 파일 상태 업데이트
        if (file && sendingFileStates.has(file._fileId)) {
            const state = sendingFileStates.get(file._fileId);
            state.statusElem.textContent = '전송 완료 (100%)';
            state.statusElem.className = 'status-badge complete';
            // 전송 완료된 파일은 sendingFileStates에서 제거 (선택 사항, UI 유지 여부에 따라)
            // sendingFilesList.removeChild(document.getElementById(`sending-file-${file._fileId}`));
            // sendingFileStates.delete(file._fileId);
        }

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
        if (event.data.startsWith('EOM:'')) { 
            const fileId = event.data.substring(4);
            const fileData = incomingFiles.get(fileId);

            if (fileData && fileData.metadata) {
                fileData.receiveStatusElem.textContent = `수신 완료`;
                console.log(`파일 수신 완료: ${fileData.metadata.filename}`);

                // Filesystem Access API는 사용하지 않으므로 무조건 Blob 생성
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
                    fileData.isComplete = true; // 완료 플래그 설정
                }
            } else {
                console.warn(`알 수 없는 파일 ID (${fileId})에 대한 EOM 신호 수신됨. incomingFiles Map:`, incomingFiles);
            }
            if (currentReceivingFileId === fileId) { 
                currentReceivingFileId = null;
            }
            updateDownloadAllButtonState(); 

        } else { // 파일 메타데이터 수신 (JSON 문자열)
            try {
                const metadata = JSON.parse(event.data);
                const fileId = metadata.fileId; 

                if (currentReceivingFileId && incomingFiles.has(currentReceivingFileId)) {
                     console.warn(`이전 파일 (${incomingFiles.get(currentReceivingFileId).metadata.filename}) EOM 없이 다음 파일 메타데이터 수신. 이전 파일 정리.`);
                     await closeSingleFileStreamAndClearReceiveState(currentReceivingFileId);
                }

                const li = document.createElement('li');
                li.id = `received-file-${fileId}`; 
                li.innerHTML = `
                    <span>${metadata.filename} (${(metadata.filesize / (1024 * 1024)).toFixed(2)} MB)</span>
                    <span id="receive-status-${fileId}" class="status-badge">수신 시작 (0%)</span>
                    <a href="#" id="save-btn-${fileId}" class="btn" style="background-color:#5bc0de;" disabled>수신 중</a>
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
                    blobUrl: null, // Filesystem Access API 사용 안함
                    isComplete: false 
                };
                incomingFiles.set(fileId, fileData); 
                currentReceivingFileId = fileId; 

                receiveStatusElem.textContent = `수신 시작: ${metadata.filename} (0%)`;
                console.log('파일 메타데이터 수신:', metadata.filename);

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

        fileData.buffers.push(event.data);
        if (fileData.currentSize > DATA_CHANNEL_BUFFER_THRESHOLD * 2 && !fileData.warnedMemory) { 
            console.warn(`파일 ${fileData.metadata.filename}이 대용량이며 메모리에 버퍼링 중입니다. 브라우저 성능에 영향을 줄 수 있습니다.`);
            fileData.warnedMemory = true; 
        }
    }
}


// =========================================================================================
// ====== 일괄 다운로드 기능 추가 =============================================================
// =========================================================================================

/**
 * 모든 수신 완료된 파일을 ZIP 파일로 묶어서 다운로드합니다.
 */
async function downloadAllFilesAsZip() {
    // isComplete 플래그와 blobUrl이 있는 파일만 필터링
    const readyFiles = Array.from(incomingFiles.values()).filter(f => f.isComplete && f.blobUrl);

    if (readyFiles.length === 0) {
        alert('다운로드할 파일이 없습니다. 모든 파일이 수신 완료되었는지 확인해주세요.');
        return;
    }

    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = '압축 중...';

    try {
        const zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));

        for (const fileData of readyFiles) {
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

        URL.revokeObjectURL(zipUrl); 
        alert(`총 ${readyFiles.length}개의 파일이 "sendfile_downloads.zip"으로 다운로드됩니다.`);

    } catch (e) {
        console.error('일괄 다운로드 (ZIP) 중 오류 발생:', e);
        alert('일괄 다운로드 중 오류가 발생했습니다. 자세한 내용은 콘솔을 확인해 주세요.');
    } finally {
        // 성공 여부와 관계없이 버튼 다시 활성화
        updateDownloadAllButtonState(); 
    }
}


/**
 * 모든 수신 관련 스트림 및 버퍼를 초기화하고 닫습니다. (전체 incomingFiles 맵 정리)
 */
async function closeAllFileStreamsAndClearReceiveState() {
    for (const [fileId, fileData] of incomingFiles.entries()) {
        if (fileData.blobUrl) { 
            URL.revokeObjectURL(fileData.blobUrl);
        }
        const liElem = document.getElementById(`received-file-${fileId}`);
        if (liElem) liElem.remove(); 
    }
    incomingFiles.clear(); 
    currentReceivingFileId = null; 

    receiveStatus.textContent = '파일 수신 대기 중...';
    updateDownloadAllButtonState(); 
}

/**
 * 특정 파일 ID에 해당하는 수신 스트림/버퍼를 초기화하고 닫습니다.
 * @param {string} fileId - 정리할 파일의 고유 ID
 */
async function closeSingleFileStreamAndClearReceiveState(fileId) {
    const fileData = incomingFiles.get(fileId);
    if (fileData) {
        if (fileData.blobUrl) { 
            URL.revokeObjectURL(fileData.blobUrl);
        }
        const liElem = document.getElementById(`received-file-${fileId}`);
        if (liElem) liElem.remove();
        incomingFiles.delete(fileId);
        if (currentReceivingFileId === fileId) {
            currentReceivingFileId = null; 
        }
        updateDownloadAllButtonState(); 
    }
}
// ===========================================================================
