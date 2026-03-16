# RSSI Mesh Detection 기획서

> "방(Room)"을 정의하지 않고, AP 신호 전파 범위를 기반으로 사람 존재를 감지하는 시스템

---

## 핵심 철학

기존 접근: "방을 정의하고 → zone 안에 사람이 있는지 확인"
새로운 접근: **"AP 신호가 도달하는 범위를 mesh로 시각화 → 신호 교란에서 사람을 추론"**

방 구조를 모르는 상태에서도 동작해야 한다.
벽이 있으면 자연스럽게 신호가 약해지고, 그것이 mesh 시각화에 반영된다.

---

## 1. 감지 원리 (1 AP + 1 ESP32-S3)

### 1-1. RSSI Variance 기반 존재 감지
- 사람 몸(수분 ~60%)은 WiFi 2.4GHz 신호를 산란시킴
- 사람이 없을 때: RSSI 안정 (variance < 0.3 dBm²)
- 사람이 있을 때: RSSI 불안정 (variance ≥ 0.5 dBm²)
- **정확도: 90-95%**, 반응 시간: 3-10초

### 1-2. 주파수 대역 분석
- **호흡 대역 (0.1-0.5 Hz)**: 사람 호흡으로 인한 미세 변동
- **모션 대역 (0.5-3.0 Hz)**: 걷기, 팔 움직임 등 동작
- FFT 기반 PSD(Power Spectral Density)로 추출

### 1-3. CSI (Channel State Information) 활용
- ESP32-S3는 56개 이상 OFDM subcarrier별 amplitude/phase 제공
- RSSI보다 5-20배 민감한 감지 가능
- Doppler shift로 이동 방향 추정 가능

### 1-4. CUSUM Change-Point Detection
- 급격한 RSSI 평균 변화 감지 (사람 진입/퇴장)
- 3σ threshold, 0.5σ drift 허용
- **오탐률 ~5%**

---

## 2. Mesh 시각화 모델

### 2-1. 신호 전파 Mesh (Room 없이)
방 대신 **AP 중심 동심원 + 감쇠 mesh**를 렌더링한다.

```
Path Loss Model: RSSI(d) = RSSI(1m) - 10 * n * log10(d)
  n = 2.0 (개방 공간)
  n = 3.0 (실내, 기본값)
  n = 4.0+ (벽/장애물 많은 환경)
```

Canvas에 그리는 것:
1. AP 위치 중심으로 신호 강도 gradient (동심원)
2. ESP32 노드 위치에서 실측 RSSI로 실제 감쇠 보정
3. 감지된 교란 영역을 **Green Neon heatmap**으로 표시

### 2-2. 장애물(벽) 추론
- 단일 AP + 단일 노드로는 벽 위치를 알 수 없음
- 대신: RSSI 실측값이 이론값보다 크게 낮으면 "장애물 존재 추정" 표시
- 노드가 추가되면 교차 검증으로 벽 윤곽 추론 가능 (미래)

### 2-3. 감지 영역 시각화
- AP-노드 사이 **Fresnel Zone** (타원 영역)이 주 감지 영역
- 이 영역 안에서의 신호 교란 = 사람 존재
- Fresnel Zone 반경: `r = sqrt(n * λ * d1 * d2 / (d1 + d2))`
  - λ = 0.125m (2.4GHz), d1/d2 = AP-사람, 사람-노드 거리

---

## 3. Config 재설계 (Room → SignalMap)

### 기존: default-room.json
```json
{ "room": { "width": 8, "height": 6 }, "zones": [...] }
```

### 새로운: default-signal-map.json
```json
{
  "signalMap": {
    "name": "My Space",
    "gridResolution": 0.25,
    "pathLossExponent": 3.0,
    "referenceRssi": -30,
    "unit": "meters"
  },
  "accessPoints": [
    {
      "id": "ap-main",
      "name": "Main AP (Router)",
      "x": 0.0,
      "y": 0.0,
      "txPower": 20,
      "frequency": 2437,
      "channel": 6
    }
  ],
  "nodes": [
    {
      "id": "node-esp32-1",
      "name": "ESP32-S3 #1",
      "x": 3.0,
      "y": 2.0,
      "type": "esp32-s3",
      "status": "disconnected"
    }
  ],
  "detection": {
    "presenceVarianceThreshold": 0.5,
    "motionEnergyThreshold": 0.1,
    "breathingBandHz": [0.1, 0.5],
    "motionBandHz": [0.5, 3.0],
    "smoothingFactor": 0.85,
    "windowSeconds": 15,
    "cusiThreshold": 3.0
  },
  "visualization": {
    "meshRadius": 8.0,
    "meshOpacity": 0.6,
    "showFresnelZone": true,
    "showSignalContours": true,
    "contourLevels": [-30, -40, -50, -60, -70, -80],
    "neonColor": "#00ff88",
    "showGrid": true,
    "gridSize": 0.5
  }
}
```

---

## 4. 새 FloorPlan → SignalMesh 렌더러

Canvas 렌더링 레이어 (기존 room 방식 대체):

| 순서 | 레이어 | 설명 |
|------|--------|------|
| 1 | Grid | 배경 격자 (좌표계) |
| 2 | Signal Contours | AP 중심 등고선 (RSSI 레벨별) |
| 3 | Fresnel Zone | AP-노드 사이 타원형 감지 영역 |
| 4 | Signal Heatmap | 실측 RSSI 기반 gradient overlay |
| 5 | AP Marker | AP 위치 + 신호 방사 애니메이션 |
| 6 | Node Marker | ESP32 위치 + 상태 |
| 7 | Detection Overlay | **Green Neon 영역** — 교란 감지된 위치 |
| 8 | Person Indicator | 감지된 존재 표시 (neon pulse) |
| 9 | Legend | 신호 강도 범례 |

### Detection Overlay 상세
- 감지 레벨에 따른 Green Neon 강도:
  - ABSENT: overlay 없음
  - PRESENT_STILL: 은은한 green glow (alpha 0.15)
  - ACTIVE: 강한 green neon pulse (alpha 0.4 + glow)
- Fresnel Zone 영역 내에서만 표시

---

## 5. 상태 모델 재설계

### 기존: zone occupancy
```
{ zones: [{ id, occupied, count }] }
```

### 새로운: signal-based presence
```javascript
{
  mode: 'simulation' | 'rssi-only' | 'rssi+csi',
  source: 'simulated' | 'wifi-rssi' | 'esp32-csi',
  connected: boolean,

  // 감지 결과
  presence: 'absent' | 'present_still' | 'active',
  confidence: 0.0 - 1.0,
  motionScore: 0.0 - 1.0,

  // 신호 분석
  rssi: {
    current: -45,        // dBm
    baseline: -42,       // 무인 기준
    variance: 1.2,       // dBm²
    snr: 25              // dB
  },

  // 스펙트럼 분석
  spectral: {
    breathingPower: 0.05,
    motionPower: 0.15,
    dominantFreq: 0.8,   // Hz
    changePoints: 2       // 최근 감지된 전환
  },

  // 감지 이력
  events: [
    { ts, type: 'enter'|'exit'|'motion'|'breathing', confidence, detail }
  ],

  // 진단
  diagnostics: {
    rssiTrend: number[],      // 최근 60값
    varianceTrend: number[],  // 최근 60값
    motionTrend: number[],
    breathingTrend: number[],
    processingTimeMs: number
  }
}
```

---

## 6. 시뮬레이션 모드 개선

보드 없이도 RSSI 감지 파이프라인 전체를 시뮬레이션:

### 시뮬레이터 행동
1. **기본 RSSI**: -42 dBm ± 0.3 dBm (Gaussian noise)
2. **사람 진입 이벤트**: 5-15초 간격으로 랜덤 발생
   - RSSI variance 급증 (0.3 → 2.0 dBm²)
   - motion band energy 증가
3. **사람 퇴장 이벤트**: variance 복귀
4. **호흡 감지**: 간헐적으로 breathing band에 0.25Hz 피크 삽입
5. **CUSUM trigger**: 진입/퇴장 시 change-point 발생

---

## 7. 개발 작업 분배 (5 Agent)

### Agent 1: Signal Map Config + Simulator
- `ui/location/config/default-signal-map.json` 생성
- `ui/location/simulator.js` — RSSI 시뮬레이션 엔진
  - 기본 RSSI + noise, 사람 이벤트 생성, 주파수 대역 시뮬레이션
- 기존 `default-room.json` 유지 (호환)

### Agent 2: SignalMesh Canvas 렌더러
- `ui/location/signal-mesh.js` — 기존 floorplan.js를 대체/보강
  - 신호 등고선 렌더링
  - Fresnel Zone 타원
  - Signal heatmap gradient
  - Green Neon detection overlay
  - AP/Node 마커 (방사 애니메이션)
  - Person indicator (neon pulse)
- 입력: signalMap config + 실시간 감지 데이터

### Agent 3: API Adapter 업데이트
- `ui/location/api.js` 수정 — presence 상태 모델 지원
  - `getPresenceData()` 메서드 추가
  - RSSI 분석 결과를 새 상태 모델로 매핑
  - 시뮬레이션 모드에서 simulator.js 데이터 활용
- `ui/location/ws.js` 수정 — presence 이벤트 지원

### Agent 4: Dashboard UI 업데이트
- `ui/location.html` 수정
  - 좌측 패널: RSSI 지표 카드 (현재 RSSI, variance, SNR, 감지 상태)
  - 우측 패널: 존재 감지 이벤트 + 호흡/모션 분석 결과
  - 하단: RSSI trend, Variance trend, Motion spectrum
  - 중앙: SignalMesh 캔버스 (floorplan 대체)
  - 감지 상태 표시: ABSENT/PRESENT_STILL/ACTIVE 배지

### Agent 5: App Orchestrator 업데이트
- `ui/location/app.js` 수정
  - SignalMesh 렌더러 연동
  - Simulator 연동 (시뮬레이션 모드)
  - 새 상태 모델 기반 UI 업데이트
  - RSSI 기반 이벤트 생성 로직
  - 감지 모드 자동 전환 (sim → rssi → csi)

---

## 8. 예상 결과

### MVP (보드 없이)
- [x] AP 중심 신호 전파 mesh 시각화
- [x] Fresnel Zone 감지 영역 표시
- [x] 시뮬레이션 기반 존재 감지 데모
- [x] RSSI variance → 감지 상태 전환
- [x] Green Neon 감지 overlay
- [x] 이벤트 타임라인 (진입/퇴장/모션/호흡)
- [x] 신호 진단 차트

### 보드 도착 후
- [ ] ESP32-S3 실측 RSSI 연결
- [ ] CSI 데이터로 감도 향상
- [ ] 환경별 pathLossExponent 캘리브레이션
- [ ] 2번째 노드 추가 시 교차 검증

---

## 9. 기존 대비 변경점

| 기존 (Room 방식) | 신규 (Signal Mesh 방식) |
|------------------|----------------------|
| 방 크기 정의 필수 | 방 정의 불필요 |
| Zone polygon 수동 설정 | AP 신호 범위가 자동 mesh |
| 구역 점유 여부 | 존재/정지/활동 상태 |
| 정적 평면도 | 동적 신호 전파 시각화 |
| 다중 노드 필수 | 단일 AP+노드로 감지 가능 |
| 위치 추정 | 존재 추정 (위치는 미래 과제) |
