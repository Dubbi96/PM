# Multi-Node Trilateration & Position Estimation Plan

> 여러 기기(ESP32, PC)를 활용해 사람의 실제 위치를 추정하는 시스템

---

## 현재 한계 (1 AP + 1 ESP32)

| 가능 | 불가능 |
|------|--------|
| 존재 감지 (있다/없다) | 어디에 있는지 (XY 좌표) |
| 모션 레벨 (정지/활동) | 여러 사람 구분 |
| 진입/퇴장 이벤트 | 이동 방향/속도 |

## 해결 방법: Multi-Node Trilateration

### 원리
- 3개 이상 노드에서 동일 신호의 RSSI를 측정
- 각 노드와 신호 소스 간 거리를 path-loss 모델로 추정
- 3개 이상 거리 → 삼각측량(trilateration)으로 XY 좌표 산출

### 필요 조건
- **최소 3개 노드** (AP 포함)가 서로 다른 위치에 배치
- 각 노드가 독립적으로 RSSI를 측정하여 서버에 보고
- 노드 간 위치(좌표)가 사전 설정되어야 함

---

## PC를 추가 ESP32 노드로 활용하는 방법

### PC WiFi Monitor Node
일반 PC/노트북의 WiFi 어댑터를 RSSI 모니터로 사용:

1. **Python 스크립트** 실행 (별도 설치 불필요)
2. 주변 WiFi RSSI를 주기적으로 스캔
3. HTTP로 메인 서버에 보고
4. 서버가 모든 노드 데이터를 취합 → trilateration 수행

### 이점
- ESP32 추가 구매 없이 즉시 노드 추가 가능
- 노트북, 데스크톱 모두 가능
- WiFi adapter만 있으면 됨

---

## Multi-Person Tracking

### 방법: Device MAC Fingerprinting
- 각 사람의 스마트폰/디바이스는 고유 MAC 주소를 가짐
- 노드들이 주변 디바이스의 RSSI를 MAC별로 측정
- MAC별로 독립 trilateration → 각 사람의 위치 추정

### 한계
- MAC 랜덤화 (iOS 14+, Android 10+): 실제 MAC 대신 랜덤 MAC 사용
- 해결책: 연결된 디바이스만 추적 (AP에 연결된 기기의 MAC은 고정)
- 또는: WiFi Probe Request 패턴으로 유사 식별

---

## 구현 계획

### 1. Config 확장
```json
{
  "nodes": [
    { "id": "ap-main", "x": 0, "y": 0, "type": "ap" },
    { "id": "esp32-1", "x": 3, "y": 2, "type": "esp32-s3" },
    { "id": "pc-node-1", "x": -2, "y": 3, "type": "pc-monitor" },
    { "id": "esp32-2", "x": 5, "y": -1, "type": "esp32-s3" }
  ]
}
```

### 2. Trilateration Algorithm
```
Input: [(x1,y1,d1), (x2,y2,d2), (x3,y3,d3), ...]
Output: (x, y) estimated position

Method: Weighted Least-Squares
- di = 10^((refRSSI - rssi_i) / (10 * n))  // distance from RSSI
- Minimize sum of weighted squared errors
- Weight = 1/di^2 (closer nodes get more weight)
```

### 3. Multi-Person State Model
```javascript
{
  trackedDevices: [
    {
      id: 'device-a1b2',
      mac: 'AA:BB:CC:DD:EE:FF',
      name: 'Person 1',
      position: { x: 2.1, y: 1.5 },
      confidence: 0.78,
      lastSeen: timestamp,
      color: '#00ff88',
      rssiByNode: {
        'ap-main': -45,
        'esp32-1': -52,
        'pc-node-1': -61
      }
    }
  ],
  nodeCount: 4,
  trilaterationActive: true,
  accuracy: 'zone' | 'approximate' | 'precise'
}
```

### 4. 정확도 등급
| 노드 수 | 정확도 | 용도 |
|---------|--------|------|
| 1 | 존재 감지만 | 있다/없다 |
| 2 | 방향 추정 | 어느 쪽인지 |
| 3 | 삼각측량 (~2-3m 오차) | 대략적 위치 |
| 4+ | 정밀 추정 (~1-2m 오차) | 구역 내 위치 |

### 5. 시각화 업데이트
- 각 추적 대상: 녹색 네온 도트 + 이름 라벨
- 위치 신뢰도 원 (반경 = 추정 오차)
- 여러 사람: 서로 다른 색상
- 노드 연결선 + RSSI 표시

---

## Agent 작업 분배

### Agent 1: CSS 레이아웃 수정 + Config 확장
- location.html 사이드바 깨짐 수정 (minWidth, overflow)
- default-signal-map.json에 멀티노드 config 추가

### Agent 2: Trilateration 엔진
- ui/location/trilateration.js 생성
- Weighted Least-Squares 알고리즘
- Multi-person tracking (MAC별 분리)
- 정확도 등급 계산

### Agent 3: 멀티노드 시뮬레이터 업데이트
- simulator.js에 멀티노드 + 멀티퍼슨 시뮬레이션 추가
- 각 노드별 독립 RSSI 생성
- 가상 사람 이동 경로 시뮬레이션

### Agent 4: SignalMesh 렌더러 업데이트
- signal-mesh.js에 멀티퍼슨 위치 표시 추가
- 각 사람: 네온 도트 + 신뢰도 원 + 이름
- 멀티노드 연결선 시각화

### Agent 5: App/Dashboard 업데이트
- app.js에 trilateration 엔진 연동
- location.html에 추적 대상 패널 추가
- 노드 수에 따른 정확도 표시
