# 📜 Nomad Corpus Platform Starter Kit

> 마크다운(UTF-8) 학술 코퍼스를 **초고속 원문 검색, 물리행 로케이터(Locator), 보안 게이트(Gate)**를 갖춘 독립 웹서비스로 즉시 배포할 수 있는 오픈소스 스타터 템플릿입니다.

---

## ⚡ 3분 빠른 시작 (Quickstart)

```bash
# 1. 저장소 클론
git clone https://github.com/nomadmeve/nomad-corpus-starter.git
cd nomad-corpus-starter

# 2. 환경 변수 설정
cp .env.example .env

# 3. 컨테이너 빌드 및 가동
docker compose up -d

# 4. 서비스 헬스체크 확인
curl -s http://127.0.0.1:3040/health | jq .
```

---

## 📁 디렉토리 구조

```text
nomad-corpus-starter/
├── src/                      # 코어 엔진 (server.js, catalog.js, gate.js)
├── sample-corpus/            # 즉시 테스트 가능한 샘플 마크다운 코퍼스
├── test/                     # 검증 단위 테스트
├── Dockerfile                # 경량 Node.js 런타임 이미지 빌드 레시피
├── compose.yaml              # Docker Compose 배포 스택 (API + Gate)
└── .env.example              # 환경 변수 템플릿
```

---

## 📚 6대 핵심 API 규격

| 엔드포인트 | 메소드 | 설명 |
| :--- | :---: | :--- |
| `/health` | `GET` | 서버 및 코퍼스 로드 상태 점검 |
| `/v1/catalog` | `GET` | 전체 문헌 계층 트리 반환 |
| `/v1/search?q={keyword}` | `GET` | 간체/번체 텍스트 고속 검색 및 Locator 반환 |
| `/v1/works/{id}` | `GET` | 문헌 본문 전체 텍스트 및 메타데이터 반환 |
| `/v1/text/convert` | `POST` | OpenCC 간체/번체 상호 변환 |
| `/v1/text/translate` | `POST` | 로컬 번역 백엔드 연동 프록시 |

---

## 🔄 새로운 코퍼스(십장 등)로 연결하는 방법

1. 보유하고 계신 마크다운 코퍼스 폴더 경로를 확인합니다 (예: `/path/to/my-corpus`).
2. `.env` 파일에서 `DAO_CANON_HOST_ROOT` 경로를 지정합니다:
   ```env
   DAO_CANON_HOST_ROOT=/path/to/my-corpus
   PORT=3140
   ```
3. `docker compose up -d`를 실행하면 새 코퍼스로 즉시 서빙됩니다.

---

## 📖 전체 기술 아키텍처 문서
전체 3단계 로드맵, CJK 도구 연동, AI 근거 대화(Evidence Shelf) 아키텍처는 공식 웹 문서 사이트에서 확인하실 수 있습니다:
👉 **[Nomad Corpus Platform Documentation](https://docs.nomadmetaverse.com)**
