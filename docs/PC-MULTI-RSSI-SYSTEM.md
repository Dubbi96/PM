# PC Multi-RSSI 관측 시스템 기획서

> ESP32 없이 여러 PC만으로 WiFi RSSI 기반 위치 감지를 검증하는 시스템

---

## 핵심 판단

| 가능 (지금 당장) | 불가능 (하드웨어 필요) |
|-----------------|---------------------|
| PC 다중 RSSI 수집 + 중앙 fusion | 일반 PC로 passive CSI 수집 |
| zone occupancy 추정 | 정밀 XY 좌표 추적 |
| baseline 대비 변화량 감지 | Intel 5300 overheard CSI |
| 다중 observer 동시 하강 검출 | 실시간 30명 추적 |

## 시스템 구조

```
┌──────────────────────────────────────────────────┐
│                    AP (Router)                    │
│              WiFi 신호 지속 발신                   │
└──────┬──────────────┬──────────────┬─────────────┘
       │              │              │
  WiFi RSSI      WiFi RSSI     WiFi RSSI
       │              │              │
┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼─────┐
│  PC Node 1 │ │  PC Node 2 │ │  PC Node 3 │
│  collector  │ │  collector  │ │  collector  │
│  (Python)   │ │  (Python)   │ │  (Python)   │
└──────┬─────┘ └──────┬─────┘ └──────┬─────┘
       │              │              │
       │    HTTP POST /api/observers/scan
       │              │              │
       └──────────────┼──────────────┘
                      │
              ┌───────▼───────┐
              │  Central      │
              │  Server       │
              │  (Fusion)     │
              ├───────────────┤
              │ - Observer    │
              │   ring buffer │
              │ - Baseline    │
              │   calibration │
              │ - Co-fluctu-  │
              │   ation check │
              │ - Zone        │
              │   inference   │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Dashboard    │
              │  (location    │
              │   .html)      │
              └───────────────┘
```

## 1. PC Observer Collector

### 역할
각 PC에서 실행되는 Python 스크립트. WiFi AP 스캔 결과를 주기적으로 서버에 전송.

### 출력 포맷
```json
{
  "observer_id": "pc-node-1",
  "timestamp_ms": 1710600000123,
  "platform": "windows",
  "aps": [
    {
      "bssid": "aa:bb:cc:dd:ee:ff",
      "ssid": "MyRouter",
      "channel": 6,
      "rssi_dbm": -42,
      "frequency_mhz": 2437
    }
  ]
}
```

### 플랫폼별 수집 방법
- **Windows**: `netsh wlan show networks mode=bssid` 파싱
- **macOS**: `/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s`
- **Linux**: `iwlist scan` 또는 `nmcli -t -f BSSID,SSID,CHAN,SIGNAL dev wifi list`

### 실행 방법
```bash
# PC Node 1에서
python pc-observer.py --id pc-node-1 --server http://192.168.1.100:8080 --interval 2

# PC Node 2에서
python pc-observer.py --id pc-node-2 --server http://192.168.1.100:8080 --interval 2

# PC Node 3에서
python pc-observer.py --id pc-node-3 --server http://192.168.1.100:8080 --interval 2
```

## 2. Server Ingest API

### 엔드포인트
```
POST /api/observers/scan     — observer 스캔 데이터 수신
GET  /api/observers/status   — 전체 observer 상태 조회
GET  /api/observers/fusion   — 현재 fusion 결과 조회
POST /api/observers/calibrate — baseline 캘리브레이션 시작
```

### 서버 동작
1. observer별 ring buffer (최근 60초, 300 샘플) 유지
2. 시간창(2초) 단위로 모든 observer 데이터 수집
3. observer별 RSSI baseline 자동 학습 (첫 30초)
4. delta(현재 - baseline) 계산
5. 다중 observer 동시 하강(co-fluctuation) 검출
6. zone occupancy 추정

## 3. Fusion Engine (Zone Inference)

### 감지 원리
- 사람이 AP-PC 사이를 지나가면 RSSI가 일시적으로 하락
- 여러 PC에서 동시에 RSSI 하락 → 교차점 영역에 사람 존재
- baseline 대비 variance 증가 → 움직임 감지

### Zone 분류 방식
정밀 XY가 아닌 zone 단위:
- **Zone A**: PC1-AP 구간 (PC1 하락 ∧ PC2 안정)
- **Zone B**: PC2-AP 구간 (PC2 하락 ∧ PC1 안정)
- **Zone C**: 교차 영역 (PC1 하락 ∧ PC2 하락)
- **None**: 모든 observer 안정

### 알고리즘
```
for each time_window (2 seconds):
  for each observer:
    delta = mean(rssi_window) - baseline
    variance = var(rssi_window)
    is_disturbed = (|delta| > 2 dBm) OR (variance > 0.5 dBm²)

  disturbed_observers = [obs for obs in observers if is_disturbed]

  if len(disturbed_observers) == 0:
    zone = 'empty'
  elif len(disturbed_observers) == 1:
    zone = disturbed_observers[0].zone_label
  else:
    zone = intersection_zone(disturbed_observers)

  confidence = mean([abs(delta) for delta in disturbed_deltas]) / 5.0
```

## 4. Dashboard 연동

### 시뮬레이션 모드
서버 없이도 동작: `observer-simulator.js`가 가상 observer 데이터 생성

### 실제 모드
서버 연결 시: `/api/observers/fusion` 폴링 → UI 업데이트

### 표시 항목
- Observer 목록 + 연결 상태
- Observer별 RSSI 실시간 차트
- Zone 점유 상태 (교란 영역 표시)
- Baseline 대비 delta 히트맵

## 5. Agent 작업 분배

### Agent 1: PC Observer Collector (`tools/pc-observer.py`)
- Cross-platform WiFi 스캔 (Windows/macOS/Linux)
- HTTP POST로 서버에 전송
- CLI 인터페이스 (--id, --server, --interval, --target-bssid)
- 설치/사용 가이드 포함

### Agent 2: Server Observer API (`v1/src/api/observers.py`)
- FastAPI 라우터: /api/observers/*
- Observer ring buffer 관리
- Baseline 자동 캘리브레이션
- 기존 서버 구조에 통합

### Agent 3: Fusion Engine (`v1/src/sensing/observer_fusion.py`)
- 다중 observer RSSI fusion
- Zone inference 알고리즘
- Co-fluctuation 검출
- 결과를 기존 presence 모델에 매핑

### Agent 4: Observer 시뮬레이터 (`ui/location/observer-simulator.js`)
- 브라우저용 가상 observer 데이터 생성
- 기존 simulator.js와 연동
- 다중 PC observer 동작 시뮬레이션

### Agent 5: Dashboard + App 업데이트
- Observer 상태 패널 추가
- Observer별 RSSI 차트
- Zone 히트맵 overlay
- 모드 전환: Simulation / PC-RSSI / ESP32-CSI

## 6. 사용 시나리오

### 최소 구성 (검증용)
- AP 1대 (기존 공유기)
- PC 2대 (노트북 2대)
- 서버 1대 (PC 중 하나가 겸용 가능)

### 권장 구성
- AP 1대
- PC 3대 (삼각 배치)
- 서버 1대 (별도 or PC 겸용)

### 테스트 방법
1. 3대 PC를 방의 서로 다른 위치에 배치
2. 각 PC에서 `python pc-observer.py` 실행
3. 서버 PC에서 `./start-location.sh` 실행
4. 대시보드에서 Observer 연결 확인
5. 사람이 AP 주변을 이동하면 zone 변화 관찰
6. baseline 캘리브레이션: 사람 없는 상태에서 30초 대기
