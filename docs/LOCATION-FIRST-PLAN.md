# RuView Location-First 재구성 기획서

> RuView를 pose-first 데모에서 **zone occupancy 중심 위치 감지 제품**으로 재해석하는 기획안

---

## 결론

RuView는 지금 상태로는 pose-first 데모입니다.
하지만 내부 구조는 이미 충분히 쓸 만합니다.

- 서버/수집/API/WebSocket 구조는 **재사용 가능**
- 기본 UI는 버리거나 debug용으로 격리
- 새 위치 중심 UI를 얹는 방향이 맞음
- 보드 도착 전에는 simulation + config + adapter + 새 화면까지 끝내두는 게 최선

핵심 목적: **"사람 모양 스켈레톤"이 아니라 "어느 구역에 사람이 있는지"**

---

## 1. 제품 방향

### 1차 목표: Zone Occupancy

정밀 좌표 추적이 아니라 **zone occupancy**로 진행합니다.

예시:
- 출입구: 점유 중
- 책상 구역: 비어 있음
- 침대 구역: 움직임 있음
- 최근 이동: 출입구 → 책상

이게 지금 RuView 기반으로 가장 현실적인 MVP입니다.

### 화면 방향

검은 pose 화면 대신 **운영자 대시보드**가 메인:

| 영역 | 내용 |
|------|------|
| **상단 상태 배너** | 시뮬레이션 / RSSI / ESP32 실측, 연결 정상 / 장비 미연결 / degraded |
| **중앙 2D 평면도** | 방 구조, 공유기/AP 위치, ESP32 노드 위치, zone A/B/C/D, 사람 존재 표시 |
| **우측 운영 패널** | 감지 인원 수, 최근 zone 이벤트, 신뢰도, 연결 상태 |
| **하단 진단 패널** | motion trend, raw signal trend, optional vitals |

---

## 2. 보드 오기 전에 꼭 해둘 것

### 2-1. Git 브랜치 분리

`feature/location-ui` 브랜치로 시작

### 2-2. 실행 프로파일 분리 (최소 3개)

| 프로파일 | 용도 |
|----------|------|
| `dev-sim` | simulation 고정 |
| `dev-ui` | 새 위치 UI 확인용 |
| `live-esp32` | 보드 연결 후 바로 전환 |

### 2-3. 새 UI 경로 만들기

기존 `ui/index.html`은 건드리더라도, 별도 경로로 분리:

```
ui/location.html
ui/location/app.js
ui/location/api.js
ui/location/ws.js
ui/location/floorplan.js
ui/location/config/default-room.json
```

### 2-4. Room Config 스키마 정의 (가장 중요)

하드웨어가 와도 이 스키마 없으면 "사람이 어디 있나"를 보여줄 수 없습니다.

필수 항목:
- 방 가로/세로
- zone polygon
- AP 좌표
- 노드 좌표
- zone 이름
- smoothing 값

### 2-5. API Adapter 만들기

RuView API는 pose/vitals 중심이라, 위치 중심 화면에 바로 맞지 않습니다.

프런트에서 **location view model**로 정규화:
- `mode`
- `connected`
- `people_count`
- `zones[]`
- `nodes[]`
- `events[]`

서버 원본을 그대로 뿌리지 말고, 한 번 변환해야 합니다.

---

## 3. 현실적인 MVP (보드 오기 전)

### MVP 기능

- [ ] 서버 상태 표시
- [ ] source 표시: simulated / wifi / esp32
- [ ] floor plan 렌더링
- [ ] zone occupancy badge
- [ ] event timeline
- [ ] 최근 motion/confidence 표시
- [ ] disconnected / no hardware / simulated 상태 구분

### 후순위 (지금 안 해도 되는 것)

- 3D
- skeleton
- model training UI
- LoRA
- vitals 메인 노출
- pose fusion

---

## 4. 1개 보드 상황의 설계 원칙

보드 1개만 있으면 **위치 추정기가 아니라 실측 파이프라인 검증기**에 가깝습니다.

zone 화면은 제공하되, 상태를 구분:

| 상태 | 의미 |
|------|------|
| **Simulation** | 화면과 흐름 검증 중 |
| **Single-node live** | 실측 입력 수신 중, 위치 정확도 제한 |
| **Multi-node live** | zone inference 활성 |

이렇게 해두면 2번째 보드가 생겨도 UI를 다시 뜯어고칠 필요 없습니다.

---

## 5. 제품 카피

초기 카피:
- "카메라처럼 보이는 위치 추적기가 아닙니다"
- "현재는 구역 기반 감지를 우선 제공합니다"
- "노드 수가 늘수록 zone 정확도가 개선됩니다"
- "시뮬레이션 모드에서는 실제 공간 위치를 의미하지 않습니다"

---

## 6. 개발 순서

1. Repo clone
2. simulation 모드 고정 실행
3. `/health`, `/api/v1/sensing/latest`, WS 구조 확인
4. 새 `location.html` 생성
5. room config loader 작성
6. floor plan + zone overlay 구현
7. adapter로 mock/sim 데이터 연결
8. 상태 배너 구현
9. event timeline 구현
10. 보드 도착 후 esp32 source로 전환

---

## 7. 재사용 판단

| 구분 | 판단 |
|------|------|
| **못 쓰는 것** | 기본 pose UI |
| **쓸 수 있는 것** | sensing server, REST API, WS, source 전환, recording 구조 |
| **추가로 만들어야 하는 것** | 위치 중심 UI, zone config, 상태 모델, adapter |

> 이건 "새로 시작"이 아니라 **"RuView를 location-first 제품으로 재해석"**하는 작업입니다.

---

## 8. 하드웨어

- **보드**: ESP32-S3-DevKitC-1 (배송 대기 중)
- 도착 전까지 simulation 기반으로 전체 파이프라인 완성
- 도착 후 `live-esp32` 프로파일로 전환하여 실측 검증
