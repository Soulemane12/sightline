#!/usr/bin/env bash
# Sightline hello/deploy script — ConfigMap + Secret + Ingress /app (no Docker build/push).
# Official skill: .cursor/skills/deployment/deploy-app-no-registry/SKILL.md
# Deltas: ARCHITECTURE.md §3 (server-side ConfigMap, sightline-env, ingress annotations).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app"
APP_NAME="sightline"
APP_PORT=8080
GPU_HOST_DEFAULT="166.19.38.112"

mapfile -t TEAM_CONFIGS < <(find /config -maxdepth 1 -type f -name '*.config' | sort)
(( ${#TEAM_CONFIGS[@]} == 1 )) || { echo "expected exactly one /config/*.config"; exit 1; }
TEAM_CONFIG="${TEAM_CONFIGS[0]}"

# Do not `source` on zsh (USERNAME is reserved). Parse with grep; never echo secret values.
cfg() { grep "^$1=" "$TEAM_CONFIG" | cut -d= -f2-; }

USERNAME="$(cfg USERNAME)"
INGRESS_URL="$(cfg INGRESS_URL)"
PASSWORD="$(cfg PASSWORD)"
GPU_BEARER_TOKEN="$(cfg GPU_BEARER_TOKEN)"
S3_ENDPOINT="$(cfg S3_ENDPOINT)"
ACCESS_KEY="$(cfg ACCESS_KEY)"
SECRET_KEY="$(cfg SECRET_KEY)"
VASTDB_BUCKET="$(cfg VASTDB_BUCKET)"

# WANDB often lives only in the VM environment (not team config).
WANDB_API_KEY="${WANDB_API_KEY:-}"
WANDB_TEAM="${WANDB_TEAM:-}"
WANDB_PROJECT="${WANDB_PROJECT:-}"

NS="$USERNAME"
export KUBECONFIG="/config/${NS}-k8s.yaml"
TEAM_N="${USERNAME#team-}"
APP_HOST="video-lab-team-${TEAM_N}.cosmos.vastdata.com"

# Pods cannot resolve the public Ingress hostname (Errno -5). Call the in-cluster
# backend Service for VSS; keep INGRESS_URL only as documentation / external API.
VSS_URL_INCLUSTER="http://video-backend-service:8000"

COSMOS3_REASON_URL="${COSMOS3_REASON_URL:-http://${GPU_HOST_DEFAULT}:8001}"
YOLO_URL="${YOLO_URL:-http://${GPU_HOST_DEFAULT}:8002}"
COSMOS_EMBED1_URL="${COSMOS_EMBED1_URL:-http://${GPU_HOST_DEFAULT}:8003}"
CANARY_1B_URL="${CANARY_1B_URL:-http://${GPU_HOST_DEFAULT}:8004}"

echo "deploy: NS=$NS APP_HOST=$APP_HOST APP_DIR=$APP_DIR"
echo "deploy: KUBECONFIG=$KUBECONFIG"
echo "deploy: VSS_URL(in-cluster)=$VSS_URL_INCLUSTER (public Ingress host used only for App path)"

# Size gate (ARCHITECTURE §3)
APP_BYTES="$(du -sb "$APP_DIR" | awk '{print $1}')"
echo "deploy: app/ size=${APP_BYTES} bytes"
if (( APP_BYTES > 900000 )); then
  echo "ERROR: app/ exceeds 900 KB ConfigMap soft limit ($APP_BYTES bytes)" >&2
  exit 1
fi
if (( APP_BYTES > 200000 )); then
  echo "WARN: app/ over 200 KB ($APP_BYTES bytes)" >&2
fi

[[ -n "$USERNAME" && -n "$INGRESS_URL" && -n "$PASSWORD" ]] || {
  echo "ERROR: USERNAME/INGRESS_URL/PASSWORD missing from team config" >&2
  exit 1
}
[[ -n "$WANDB_API_KEY" && -n "$WANDB_TEAM" && -n "$WANDB_PROJECT" ]] || {
  echo "ERROR: WANDB_API_KEY/WANDB_TEAM/WANDB_PROJECT must be set in the environment" >&2
  exit 1
}

kubectl -n "$NS" get ns "$NS" >/dev/null

# 1) ConfigMap (server-side apply)
kubectl -n "$NS" create configmap "${APP_NAME}-code" \
  --from-file="$APP_DIR" \
  --dry-run=client -o yaml \
  | kubectl apply --server-side --force-conflicts -f -

# 2) Secret (never printed)
kubectl -n "$NS" create secret generic "${APP_NAME}-env" \
  --from-literal=VSS_URL="$VSS_URL_INCLUSTER" \
  --from-literal=VSS_USERNAME="$USERNAME" \
  --from-literal=VSS_PASSWORD="$PASSWORD" \
  --from-literal=WANDB_API_KEY="$WANDB_API_KEY" \
  --from-literal=WANDB_TEAM="$WANDB_TEAM" \
  --from-literal=WANDB_PROJECT="$WANDB_PROJECT" \
  --from-literal=GPU_BEARER_TOKEN="$GPU_BEARER_TOKEN" \
  --from-literal=COSMOS3_REASON_URL="$COSMOS3_REASON_URL" \
  --from-literal=YOLO_URL="$YOLO_URL" \
  --from-literal=COSMOS_EMBED1_URL="$COSMOS_EMBED1_URL" \
  --from-literal=CANARY_1B_URL="$CANARY_1B_URL" \
  --from-literal=S3_ENDPOINT="$S3_ENDPOINT" \
  --from-literal=ACCESS_KEY="$ACCESS_KEY" \
  --from-literal=SECRET_KEY="$SECRET_KEY" \
  --from-literal=VASTDB_BUCKET="$VASTDB_BUCKET" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

# 3) Deployment + Service + Ingress
kubectl -n "$NS" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
  labels:
    app: ${APP_NAME}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${APP_NAME}
  template:
    metadata:
      labels:
        app: ${APP_NAME}
    spec:
      containers:
      - name: app
        image: python:3.12-slim
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: ${APP_PORT}
        env:
        - name: PORT
          value: "${APP_PORT}"
        - name: PYTHONDONTWRITEBYTECODE
          value: "1"
        envFrom:
        - secretRef:
            name: ${APP_NAME}-env
        volumeMounts:
        - name: code
          mountPath: /code
        workingDir: /code
        command: ["bash", "-c"]
        args:
        - |
          set -euo pipefail
          if [ -f requirements.txt ]; then
            pip install --no-cache-dir -q -r requirements.txt
          fi
          exec python main.py
        readinessProbe:
          httpGet:
            path: /health
            port: ${APP_PORT}
          initialDelaySeconds: 45
          periodSeconds: 10
          failureThreshold: 36
        resources:
          requests:
            cpu: "100m"
            memory: "256Mi"
          limits:
            memory: "1536Mi"
      volumes:
      - name: code
        configMap:
          name: ${APP_NAME}-code
---
apiVersion: v1
kind: Service
metadata:
  name: ${APP_NAME}
  labels:
    app: ${APP_NAME}
spec:
  selector:
    app: ${APP_NAME}
  ports:
  - name: http
    port: 80
    targetPort: ${APP_PORT}
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${APP_NAME}
  labels:
    app: ${APP_NAME}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /\$2
    nginx.ingress.kubernetes.io/proxy-body-size: "200m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
spec:
  ingressClassName: nginx
  rules:
  - host: ${APP_HOST}
    http:
      paths:
      - path: /app(/|\$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: ${APP_NAME}
            port:
              number: 80
EOF

# ConfigMap updates are not hot — force new pods
kubectl -n "$NS" rollout restart "deploy/${APP_NAME}"

DEPLOY_START="$(date +%s)"
echo "deploy: waiting for rollout…"
kubectl -n "$NS" rollout status "deploy/${APP_NAME}" --timeout=300s
DEPLOY_END="$(date +%s)"
echo "deploy: rollout_wait_s=$((DEPLOY_END - DEPLOY_START))"

kubectl -n "$NS" get pods,svc,ingress -l "app=${APP_NAME}"

echo "deploy: curling cluster Ingress http://${APP_HOST}/app/health"
curl -sS -o /tmp/sightline_health.json -w "health_http=%{http_code}\n" "http://${APP_HOST}/app/health" || true
cat /tmp/sightline_health.json 2>/dev/null; echo

echo "deploy: curling http://${APP_HOST}/app/api/probe"
curl -sS -o /tmp/sightline_probe.json -w "probe_http=%{http_code}\n" "http://${APP_HOST}/app/api/probe" || true
# Probe JSON has no secrets by design; still avoid dumping huge payloads
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/tmp/sightline_probe.json')
if not p.exists() or not p.read_text().strip():
    print('probe: empty response')
else:
    try:
        d=json.loads(p.read_text())
        print('probe ok=', d.get('ok'))
        for c in d.get('checks') or []:
            print(f"  {c.get('name')}: ok={c.get('ok')} latency={c.get('latency_s')} detail={c.get('detail')}")
    except Exception as e:
        print('probe parse error', e, 'raw_len', len(p.read_text()))
PY

echo
echo "=== OPEN THE APP ==="
echo "On your laptop: https://workshop.thecosmoslabs.com → App"
echo "Cluster check host (not for humans): http://${APP_HOST}/app/"
echo "Do NOT open \$INGRESS_URL for the UI."
