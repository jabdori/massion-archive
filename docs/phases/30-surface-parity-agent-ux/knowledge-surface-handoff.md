# 핸드오프 — 지식 표면과 통합 이웃 조회

> **상태:** 화면 완성, **계약은 이후 구현됨**. 아래 본문은 작성 시점(2026-07-27) 진단이며 그대로 읽으면 안 됩니다
> **정정:** 2026-08-09 코드 대조. 이 문서가 「없음」으로 적은 세 조회 `knowledge.index`·`knowledge.graph`·`knowledge.links`는 **모두 존재합니다** — `ApplicationQueryMapV1`과 `query-registry`에 등록돼 있고 데스크톱이 실제로 호출합니다. 아래 계약 설계는 이미 반영된 것으로 읽으십시오.
> **작성일:** 2026-07-27
> **결정:** [ADR-002 지식 축과 표면 복원](../../architecture/ADR-002-knowledge-axis-restoration.md)
> **관련:** [제품 헌법 §5·§6·§9.6](../../product/constitution.md), [근거 관계 그래프](knowledge-graph-handoff.md)

## 1. 무엇이 없는가

`지식` 표면은 완성본 기준으로 만들어져 있고 **열1만 실제로 동작합니다.**

| 열 | 내용 | 계약 |
|---|---|---|
| 1 렌즈 | 워크스페이스 선택 + 업무별·문서별·파일별 | **부분** — `workspace.list` · `workspace.trust` · `workspace.archive`만 있음 |
| 2 그래프 캔버스 | **같은 종류끼리만** 이은 지도 | **없음** |
| 3 시트 | 고른 노드의 내용 + 전체 연결 목록 | **없음** |

열은 고정 3열이 아닙니다. 아무것도 고르지 않으면 캔버스가 폭을 다 쓰고, 노드를 고를 때만 시트가 열려 셋이 됩니다.

도메인에는 재료가 다 있습니다. `RepositoryStore`, `IndexStore`(`IndexedSourceFile · IndexedSymbol · IndexedChunk · IndexedRelation`), `CodeSearchService`(exact·BM25 + embedding port), `CodeGraphService.neighbors()`. **계약이 `work.knowledge` 하나만 노출합니다.**

## 2. 필요한 조회 둘

### 2.1 `knowledge.index`

```ts
export interface KnowledgeIndexViewV1 {
  readonly workspaceId: string;
  readonly status: "ready" | "indexing" | "stale" | "none";
  readonly indexVersionId?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationCount: number;
  readonly indexedAt?: string;
  /** 색인에서 제외된 패턴. "왜 안 보이지"를 화면이 답할 수 있게 합니다. */
  readonly excluded: readonly string[];
}
```

`RepositoryStore`의 IndexVersion과 `IndexStore.getSnapshot()`의 배열 길이로 채웁니다. 새 계산이 없습니다.

### 2.2 `knowledge.graph` — 렌즈 하나의 지도

```ts
payload: { workspaceId: string; lens: KnowledgeNodeKindV1 }

export type KnowledgeNodeKindV1 = "symbol" | "file" | "document" | "work" | "artifact" | "agent";

export interface KnowledgeNodeViewV1 {
  readonly nodeId: string;        // `${kind}:${id}` 형태
  readonly kind: KnowledgeNodeKindV1;
  readonly label: string;         // 사람이 읽는 이름
  readonly detail?: string;       // 경로 또는 소속
  readonly group?: string;        // 색을 나누는 기준. 보통 폴더
}

export interface KnowledgeGraphEdgeViewV1 {
  readonly kind: KnowledgeRelationKindV1;   // contains|imports|calls|implements|documents
  readonly sourceId: string;
  readonly targetId: string;
  readonly unresolved?: boolean;
  /** 직접 관계가 아니라 공유한 것으로 이어졌다면 그 이름. */
  readonly derivedVia?: string;
}

export interface KnowledgeGraphViewV1 {
  readonly lens: KnowledgeNodeKindV1;
  readonly nodes: readonly KnowledgeNodeViewV1[];
  readonly edges: readonly KnowledgeGraphEdgeViewV1[];
}
```

**심볼은 렌즈가 아닙니다.** 심볼 1,800개를 한 캔버스에 펼치면 답하는 질문이 없습니다 — 찾을 방법 없이 점만 많고, 실제로 알고 싶은 "이 심볼이 무엇과 엮였나"는 파일을 눌렀을 때 시트의 «품고 있는 것»과 업무의 `근거` 탭이 이미 답합니다. `knowledge.links`는 심볼을 그대로 돌려주고 지도만 세 렌즈(work·document·file)로 좁힙니다.

**같은 종류만 담으십시오.** 업무 지도에는 업무만, 파일 지도에는 파일만 들어갑니다. 이종 연결(업무↔문서↔파일↔심볼)은 캔버스가 아니라 `knowledge.links`가 시트에 보여줍니다. 한 캔버스에 종류를 섞으면 "무엇의 지도인지"가 사라지고 노드가 늘수록 읽을 수 없게 됩니다.

같은 종류를 잇는 근거는 둘이고, **둘을 구분해서 보내야 합니다.**

- **직접** — 도메인에 실재하는 동종 관계. 파일의 `imports`, 심볼의 `calls`·`implements`, 문서끼리의 참조.
- **공유(`derivedVia`)** — 같은 것을 쓴 사이. **업무끼리가 여기 해당합니다.** 업무는 서로를 부르지 않고, 같은 파일·문서를 건드렸기 때문에 이어집니다. 무엇을 공유했는지 이름을 함께 보내십시오 — 왜 이어졌는지 말하지 못하면 사용자에게는 우연한 선으로 보입니다. 화면은 이 간선을 점선으로 그립니다.

### 2.3 `knowledge.links` — 고른 노드의 전체 연결

```ts
payload: { workspaceId: string; nodeId: string }

export interface KnowledgeLinkViewV1 {
  readonly node: KnowledgeNodeViewV1;
  readonly kind: KnowledgeRelationKindV1;
  readonly direction: "outgoing" | "incoming";
  readonly unresolved?: boolean;
}
```

**이것만은 렌즈로 좁히지 마십시오.** 지도는 좁혀 보지만 고른 것의 연결까지 좁히면 "이 파일이 여러 업무에 걸려 있고 여러 문서에서 언급된다"를 볼 수 없습니다. 그게 이 표면의 존재 이유입니다.

## 3. 진짜 일 — 관계 저장소가 셋으로 갈려 있습니다

단일 간선 테이블이 없습니다. **application 계층에서 조인해 하나의 이웃으로 합쳐야 합니다.**

| 저장소 | 관계 | 위치 |
|---|---|---|
| evidence | `contains · imports · calls · implements · documents` | `packages/evidence/src/extractors.ts:31`, 순회는 `graph.ts:29` |
| organization | `OrganizationReference.kind` — work·agent·task·conversation·memory·approval·permission·prompt·skill·extension | `packages/organization/src/organization.ts` |
| growth | `source_reference_ids` — `work:` `message:` `verification:` `organization:` `execution:` `artifact:` | `packages/growth` |

합칠 때 지킬 것:

- **`nodeId`는 `${kind}:${id}`로 통일하십시오.** 세 저장소가 서로 다른 id 공간을 쓰므로 접두어가 없으면 충돌합니다.
- **다섯 관계 종류로 사상하십시오.** 코드 밖 관계도 이 다섯에 담깁니다 — 예: Work가 파일을 근거로 썼다 → `documents/outgoing`(화면에서는 「이것이 참고한 것」). 새 종류를 늘리기 전에 기존 다섯으로 표현되는지 먼저 보십시오. 화면 문구가 종류마다 방향별로 둘씩 있어 종류를 늘리면 문구가 둘씩 늘어납니다.
- **`group`을 채우십시오.** 보통 폴더입니다. 화면이 이걸로 색을 나눕니다 — 무작위 색은 색덩이가 아무 뜻도 없어 눈만 피로해지고, 폴더로 칠하면 뭉친 색이 곧 "이 영역이 서로 많이 부른다"는 사실이 됩니다.
- **`unresolved`를 삼키지 마십시오.** `CodeGraphResult.unresolved`가 이미 분리해 둡니다. 해결된 것처럼 보내면 화면이 없는 연결을 그립니다.
- **`knowledge.graph`는 렌즈로 좁히고 `knowledge.links`는 좁히지 않습니다.** 둘의 범위가 다른 것이 의도입니다.

### 열지 않은 문

§9.6이 **측정된 실패가 있을 때만** 열라고 정한 것들입니다. 이 핸드오프는 열지 않습니다.

- **SurrealDB native relation(`RELATE`)** — 순회 성능 실패가 측정될 때만. 지금은 application 계층 조인입니다.
- **LSP** — cross-file 정확도 실패가 반복될 때만.
- **embedding provider** — 검색 품질 실패가 측정될 때만.

## 4. 프론트엔드 상태

| 계층 | 위치 |
|---|---|
| 뷰 타입 | `desktop-service.ts` `KnowledgeNodeView` · `KnowledgeGraphEdgeView` · `KnowledgeGraphView` · `KnowledgeLinkView` · `KnowledgeIndexView` |
| 서비스 | 같은 파일 `loadKnowledgeIndex` · `loadKnowledgeGraph` · `loadKnowledgeLinks` — 실 경로는 빈 결과를 돌려주고 화면이 "아직 색인되지 않았습니다"라고 말합니다 |
| 표면 | `app.tsx` `KnowledgeSurface` · `KnowledgeGraph` · `KnowledgeLinkList` |
| 문구 | `app.tsx` `knowledgeNodeKindLabel` · `knowledgeEdgeLabel` · `knowledgeNodeTone` |
| fixture | `desktop-service.ts` `fixtureKnowledgeNodes` · `fixtureKnowledgeEdges` — 업무·문서·파일·심볼·산출물이 한 간선 목록으로 이어진 완성본 |

**캔버스는 모양과 연결만 나르고 읽는 일은 시트가 합니다.** 이 분담이 깨지면 캔버스가 목록이 되고, 그러면 시트와 하는 일이 같아져 그래프가 없는 것과 같습니다.

**ReactFlow를 쓰지 않습니다.** ReactFlow는 노드 에디터(상자·핸들·직교 간선)라 지식 그래프의 생김새가 나오지 않습니다. 여기 필요한 것은 점·선·라벨과 유기적인 뭉침이라 SVG로 직접 그립니다. 조직 지도는 ReactFlow를 그대로 씁니다 — 거기는 고정된 계층 트리라 성격이 다릅니다.

**배치는 Fruchterman–Reingold를 정해진 횟수만 돌린 결과입니다.** 애니메이션하지 않고 시드가 인덱스라 같은 자료는 늘 같은 자리에 놓입니다 — 두 번째로 열었을 때 기억이 쓸모가 있어야 합니다. 원의 크기는 연결 수입니다.

**고른 노드에 걸린 선만 살리고 나머지는 가라앉힙니다.** 옵시디언이 하는 것과 같고, 이게 없으면 선이 많아질수록 무엇에 걸렸는지 못 읽습니다.

## 5. 완료 판정

- [ ] `knowledge.index` · `knowledge.graph` · `knowledge.links`가 `ApplicationQueryMapV1`에 있고 실제 워크스페이스에서 채워진다
- [ ] `knowledge.graph`에 **같은 종류만** 들어 있다. 종류가 섞이면 렌즈가 무너진 것이다
- [ ] `knowledge.links`에 **코드 밖 노드가 섞여 나온다**(업무·문서·산출물). 코드 관계만 나오면 조인이 안 된 것이다
- [ ] 업무끼리의 간선에 `derivedVia`가 채워져 있다(무엇을 공유해서 이어졌는지)
- [ ] `nodeId` 접두어가 세 저장소에서 충돌하지 않는다
- [ ] `direction`이 정확하다(부른 쪽과 불린 쪽이 뒤바뀌지 않는다)
- [ ] `unresolved`가 해결된 것으로 둔갑하지 않는다
- [ ] `knowledge.graph`는 렌즈로 좁혀 돌려주고, `knowledge.links`는 좁히지 않는다
- [ ] 신뢰하지 않은 워크스페이스는 색인·이웃을 돌려주지 않는다
- [ ] 파일 하나를 골랐을 때 시트에 **여러 업무와 여러 문서가 함께** 나온다
- [ ] 실제 워크스페이스에서 지도를 두 번 이상 걸어간 증거를 `docs/evidence/phase-30/`에 남긴다
