# Continuous Position Estimation Plan

> RSSI 값으로 사람의 위치를 연속적으로 추정하는 시스템

## 핵심 원리

RSSI는 거리에 비례해 감쇠한다:
```
distance = 10^((refRSSI - currentRSSI) / (10 * n))
```

각 observer의 RSSI 변화량(delta)으로 **사람과 해당 observer 사이의 상대 거리**를 추정할 수 있다.

## 위치 추정 방식

### 1노드 (ESP32 only)
- AP-ESP32 라인 위에서 RSSI delta로 위치 이동
- delta 크면 → 사람이 AP-ESP32 중간에 가까이 있음
- delta 작으면 → 사람이 멀리 있거나 없음

### 다중 노드
- 각 노드의 delta를 가중치로 사용
- `weight_i = |delta_i| / sum(|delta_all|)`
- `person_position = sum(weight_i * midpoint(AP, node_i))`
- 가중 평균 → delta 큰 observer 쪽으로 dot 이동

### 시간 연속성 (EMA smoothing)
- `new_position = 0.15 * measured + 0.85 * previous`
- 급격한 점프 방지, 자연스러운 이동

## Agent 작업 분배

### Agent 1: Position Estimator (app.js)
- RSSI delta 기반 가중 위치 계산
- EMA 스무딩 (0.15 factor)
- 내부 `_estimatedPosition` 상태 유지

### Agent 2: Bridge enhancement (esp32-bridge.py)
- 개별 CSI 프레임에서 RSSI 변동 방향 추적
- 이동 에너지(motion energy) 전달

### Agent 3: Renderer smooth movement (signal-mesh.js)
- lerp factor 더 강화
- 위치 변화 시 부드러운 trail

### Agent 4: Observer-server fusion improvement
- delta 기반 가중치 계산을 서버에서도 수행
- 응답에 estimated_position 포함

### Agent 5: Test + integration + push
