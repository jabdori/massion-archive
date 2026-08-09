import { useEffect, useMemo, useRef, useState } from "react";

import type { KnowledgeGraphView, KnowledgeNodeView } from "@/desktop-service";
import { formatLocalizedNumber, translate, useI18n } from "@/i18n/context";
import { localeTag } from "@/i18n/locale";

/**
 * 옵시디언 그래프 뷰. **ReactFlow를 쓰지 않습니다** — 그건 노드 에디터(상자·핸들·직교 간선)라
 * 지식 그래프의 생김새도, 물리도, 규모도 나오지 않습니다.
 *
 * 갖춰야 하는 것(obsidian.md 그래프 뷰 기준):
 *  - 휠 줌(커서 기준) · `+`/`-`(뷰 중심 기준) · `0` 전체 보기
 *  - 빈 곳 드래그로 이동 · 방향키 · Shift로 가속
 *  - 노드 끌기(끄는 동안 고정, 놓으면 물리가 이어받음)
 *  - hover 시 그 노드의 연결만 살리고 나머지는 가라앉힘, 이름은 배율과 무관하게 표시
 *  - 확대 수준에 따라 라벨이 서서히 나타남(text fade), 겹치면 건너뜀
 *  - 연결 수에 비례한 노드 크기, 노드끼리 겹치지 않음(collide)
 *  - 힘을 바꾸면 **즉시 다시 움직임**
 */

export interface KnowledgeForceSettings {
  readonly center: number;
  readonly repel: number;
  readonly link: number;
  readonly distance: number;
  readonly textFade: number;
  readonly nodeSize: number;
}

/**
 * 정착이 끝난 뒤에도 남기는 최소 활동량. 0이면 그래프가 그림이 되고,
 * 크면 떨립니다. 눈에 거슬리지 않으면서 살아 있다고 느껴지는 지점입니다.
 */
const KNOWLEDGE_ALPHA_FLOOR = 0.016;

export const KNOWLEDGE_FORCE_DEFAULTS: KnowledgeForceSettings = {
  center: 0.12,
  repel: 1,
  link: 1,
  distance: 72,
  textFade: 1,
  nodeSize: 1,
};

/*
 * 그룹 색. 폴더에서 나옵니다(옵시디언이 폴더로 묶는 것과 같습니다).
 *
 * DESIGN.md는 색을 에이전트에게만 줍니다. 여기는 에이전트가 없는 캔버스이고 색이
 * 장식이 아니라 구조를 나르므로 예외를 두되 두 가지를 지킵니다.
 *  - **예약어를 침범하지 않습니다.** 노랑(gate=사람이 필요함)·초록(성공 오독)·코랄(halt)이 없습니다.
 *  - **에이전트 슬롯 hex를 쓰지 않습니다.** 청보라~슬레이트 한 계열로 묶어 조용한 다른 언어로 읽히게 합니다.
 * 색이 뜻을 가지므로 화면에 범례가 함께 있어야 합니다(KnowledgeGroupLegend).
 */
export const KNOWLEDGE_GROUP_TONES = [
  "#8ea6cc",
  "#a89ac6",
  "#7d90b4",
  "#b3a8cc",
  "#93a2bd",
  "#9a93bd",
  "#8598b0",
  "#a5a0c2",
] as const;

export function knowledgeGroupTone(group: string | undefined): string {
  if (group === undefined) return "#8a8a92";
  let hash = 2166136261;
  for (let i = 0; i < group.length; i += 1) {
    hash ^= group.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return KNOWLEDGE_GROUP_TONES[Math.abs(hash) % KNOWLEDGE_GROUP_TONES.length] ?? "#8a8a92";
}

interface SimNode {
  readonly id: string;
  readonly node: KnowledgeNodeView;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  radius: number;
  fixed: boolean;
}

interface SimEdge {
  readonly source: SimNode;
  readonly target: SimNode;
}

/** Barnes–Hut 사분트리. 노드 수천 개에서 O(n²) 반발은 프레임을 잡아먹습니다. */
interface QuadCell {
  x: number;
  y: number;
  size: number;
  mass: number;
  cx: number;
  cy: number;
  body: SimNode | undefined;
  children: QuadCell[] | undefined;
}

function newCell(x: number, y: number, size: number): QuadCell {
  return { x, y, size, mass: 0, cx: 0, cy: 0, body: undefined, children: undefined };
}

function insert(cell: QuadCell, body: SimNode, depth: number): void {
  cell.mass += 1;
  cell.cx += (body.x - cell.cx) / cell.mass;
  cell.cy += (body.y - cell.cy) / cell.mass;
  if (depth > 18) return;
  if (!cell.children && cell.body === undefined && cell.mass === 1) {
    cell.body = body;
    return;
  }
  if (!cell.children) {
    const half = cell.size / 2;
    cell.children = [0, 1, 2, 3].map((index) =>
      newCell(cell.x + (index % 2) * half, cell.y + (index < 2 ? 0 : 1) * half, half),
    );
    const existing = cell.body;
    cell.body = undefined;
    if (existing) insert(pick(cell, existing), existing, depth + 1);
  }
  insert(pick(cell, body), body, depth + 1);
}

function pick(cell: QuadCell, body: SimNode): QuadCell {
  const half = cell.size / 2;
  const index = (body.x >= cell.x + half ? 1 : 0) + (body.y >= cell.y + half ? 2 : 0);
  return cell.children?.[index] ?? cell;
}

function repelFrom(cell: QuadCell, body: SimNode, theta: number, strength: number): void {
  if (cell.mass === 0) return;
  const dx = cell.cx - body.x;
  const dy = cell.cy - body.y;
  const distanceSquared = dx * dx + dy * dy || 1;
  if (cell.children === undefined || (cell.size * cell.size) / distanceSquared < theta * theta) {
    if (cell.body === body) return;
    const force = (-strength * cell.mass) / distanceSquared;
    const distance = Math.sqrt(distanceSquared);
    body.vx += (dx / distance) * force;
    body.vy += (dy / distance) * force;
    return;
  }
  for (const child of cell.children) repelFrom(child, body, theta, strength);
}

export function KnowledgeGraphCanvas({
  forces,
  graph,
  label,
  onSelect,
  selectedId,
}: {
  forces: KnowledgeForceSettings;
  graph: KnowledgeGraphView;
  /** 사람이 읽는 지도 이름. 도메인 열거값을 접근성 이름으로 노출하지 않습니다. */
  label: string;
  onSelect: (nodeId: string | undefined) => void;
  selectedId: string | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [settling, setSettling] = useState(0);

  const forcesRef = useRef(forces);
  const selectedRef = useRef(selectedId);
  const hoverRef = useRef(hoverId);
  forcesRef.current = forces;
  selectedRef.current = selectedId;
  hoverRef.current = hoverId;

  const sim = useMemo(() => {
    const byId = new Map<string, SimNode>();
    for (const node of graph.nodes) {
      byId.set(node.nodeId, {
        id: node.nodeId,
        node,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        degree: 0,
        radius: 4,
        fixed: false,
      });
    }
    const edges: SimEdge[] = [];
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const source = byId.get(edge.sourceId);
      const target = byId.get(edge.targetId);
      if (!source || !target) continue;
      source.degree += 1;
      target.degree += 1;
      edges.push({ source, target });
      for (const [from, to] of [
        [edge.sourceId, edge.targetId],
        [edge.targetId, edge.sourceId],
      ] as const) {
        const bucket = adjacency.get(from);
        if (bucket) bucket.push(to);
        else adjacency.set(from, [to]);
      }
    }
    const nodes = [...byId.values()];
    for (const node of nodes) node.radius = 3.2 + Math.sqrt(node.degree) * 2.1;

    /*
     * 자리를 **이어진 순서대로** 깝니다.
     *
     * 그냥 나선으로 뿌리면 서로 부르는 두 파일이 화면 반대편에서 시작하고, 그 긴 스프링이
     * 한꺼번에 당겨지면서 처음 몇 초가 요동칩니다. 연결이 많은 것에서 너비 우선으로 훑어
     * 이웃끼리 붙여 두면 시작 에너지가 훨씬 작아 금방 가라앉습니다.
     */
    const order: SimNode[] = [];
    const seen = new Set<string>();
    const roots = [...nodes].sort((left, right) => right.degree - left.degree);
    for (const root of roots) {
      if (seen.has(root.id)) continue;
      seen.add(root.id);
      const queue = [root.id];
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) continue;
        const node = byId.get(id);
        if (node) order.push(node);
        for (const next of adjacency.get(id) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    order.forEach((node, index) => {
      const angle = index * 2.399963;
      node.x = Math.cos(angle) * 22 * Math.sqrt(index + 1);
      node.y = Math.sin(angle) * 22 * Math.sqrt(index + 1);
    });

    // 큰 것을 뒤에 그려 위로 올리고, 히트테스트도 같은 순서를 역으로 씁니다.
    nodes.sort((left, right) => left.radius - right.radius);
    const neighbors = new Map<string, Set<string>>();
    for (const edge of edges) {
      neighbors.set(edge.source.id, (neighbors.get(edge.source.id) ?? new Set()).add(edge.target.id));
      neighbors.set(edge.target.id, (neighbors.get(edge.target.id) ?? new Set()).add(edge.source.id));
    }
    return { byId, edges, neighbors, nodes };
  }, [graph]);

  const transform = useRef({ x: 0, y: 0, k: 1 });
  const alpha = useRef(1);
  const settleLeft = useRef(0);
  const settleTotal = useRef(1);
  const dirty = useRef(true);

  /** 힘을 바꾸면 물리를 다시 데웁니다. 이게 없으면 슬라이더가 장식이 됩니다. */
  useEffect(() => {
    alpha.current = Math.max(alpha.current, 0.32);
    dirty.current = true;
  }, [forces]);

  useEffect(() => {
    dirty.current = true;
  }, [hoverId, selectedId]);

  useEffect(() => {
    alpha.current = 1;
    const target = Math.min(520, 220 + Math.floor(sim.nodes.length / 4));
    settleLeft.current = target;
    settleTotal.current = target;
    setSettling(target);
  }, [sim]);

  /** 백분위 경계로 맞춥니다. 멀리 떨어진 한둘이 화면의 절반을 가져가지 않게. */
  const fit = () => {
    const canvas = canvasRef.current;
    if (!canvas || sim.nodes.length === 0) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const xs = sim.nodes.map((node) => node.x).sort((a, b) => a - b);
    const ys = sim.nodes.map((node) => node.y).sort((a, b) => a - b);
    const at = (list: number[], ratio: number) => list[Math.min(list.length - 1, Math.floor(list.length * ratio))] ?? 0;
    const minX = at(xs, 0.02);
    const maxX = at(xs, 0.98);
    const minY = at(ys, 0.02);
    const maxY = at(ys, 0.98);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const k = Math.min(3, Math.max(0.05, Math.min(width / (spanX * 1.2), height / (spanY * 1.2))));
    transform.current = {
      k,
      x: width / 2 - ((minX + maxX) / 2) * k,
      y: height / 2 - ((minY + maxY) / 2) * k,
    };
    dirty.current = true;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let disposed = false;
    let lastWidth = wrap.clientWidth;
    let lastHeight = wrap.clientHeight;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      /*
       * 크기가 바뀌어도 **보고 있던 월드 중심을 유지**합니다. 시트가 열려 캔버스가 좁아질 때
       * 이걸 안 하면 방금 고른 노드가 시트 뒤로 사라집니다.
       */
      if (lastWidth > 0 && lastHeight > 0 && (width !== lastWidth || height !== lastHeight)) {
        const { k, x, y } = transform.current;
        const centerX = (lastWidth / 2 - x) / k;
        const centerY = (lastHeight / 2 - y) / k;
        transform.current = { k, x: width / 2 - centerX * k, y: height / 2 - centerY * k };
      }
      lastWidth = width;
      lastHeight = height;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      canvas.style.width = `${String(width)}px`;
      canvas.style.height = `${String(height)}px`;
      dirty.current = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const tick = () => {
      const setting = forcesRef.current;
      const nodes = sim.nodes;
      if (nodes.length === 0) return;
      dirty.current = true;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
      }
      const size = Math.max(maxX - minX, maxY - minY, 1) * 1.1;
      const root = newCell(minX, minY, size);
      for (const node of nodes) insert(root, node, 0);

      const repelStrength = (260 + nodes.length * 0.9) * setting.repel * alpha.current;
      for (const node of nodes) {
        if (node.fixed) continue;
        repelFrom(root, node, 0.9, repelStrength);
        node.vx -= node.x * 0.014 * setting.center * alpha.current;
        node.vy -= node.y * 0.014 * setting.center * alpha.current;
      }
      for (const edge of sim.edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const distance = Math.max(0.5, Math.hypot(dx, dy));
        const push = ((distance - setting.distance) / distance) * 0.42 * setting.link * alpha.current;
        const fx = dx * push;
        const fy = dy * push;
        if (!edge.source.fixed) {
          edge.source.vx += fx;
          edge.source.vy += fy;
        }
        if (!edge.target.fixed) {
          edge.target.vx -= fx;
          edge.target.vy -= fy;
        }
      }

      /*
       * 충돌. **보이는 점 = 누를 수 있는 점**이 되려면 노드가 서로 겹쳐서는 안 됩니다.
       * 겹친 채 멈추면 큰 허브 아래 깔린 작은 노드가 클릭을 가로챕니다.
       * 사분트리를 다시 쓰지 않고 격자로 근처만 봅니다 — 충돌은 국소적이라 그걸로 충분합니다.
       */
      const scale = setting.nodeSize;
      const cellSize = Math.max(8, 24 * scale);
      const grid = new Map<string, SimNode[]>();
      for (const node of nodes) {
        const key = `${String(Math.floor(node.x / cellSize))}:${String(Math.floor(node.y / cellSize))}`;
        // push로 담습니다. spread로 매번 복사하면 한 셀에 뭉칠수록 비용이 제곱으로 커집니다.
        const bucket = grid.get(key);
        if (bucket) bucket.push(node);
        else grid.set(key, [node]);
      }
      for (const node of nodes) {
        const cellX = Math.floor(node.x / cellSize);
        const cellY = Math.floor(node.y / cellSize);
        for (let ox = -1; ox <= 1; ox += 1) {
          for (let oy = -1; oy <= 1; oy += 1) {
            for (const other of grid.get(`${String(cellX + ox)}:${String(cellY + oy)}`) ?? []) {
              if (other === node) continue;
              const dx = other.x - node.x;
              const dy = other.y - node.y;
              const distance = Math.hypot(dx, dy) || 0.01;
              const want = (node.radius + other.radius) * scale + 2;
              if (distance >= want) continue;
              // alpha에 묶습니다. 안 묶으면 물리가 식은 뒤에도 서로 밀며 영원히 떨립니다.
              const shift = ((want - distance) / distance) * 0.5 * Math.min(1, alpha.current * 6);
              if (!node.fixed) {
                node.vx -= dx * shift;
                node.vy -= dy * shift;
              }
              if (!other.fixed) {
                other.vx += dx * shift;
                other.vy += dy * shift;
              }
            }
          }
        }
      }

      for (const node of nodes) {
        if (node.fixed) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx *= 0.58;
        node.vy *= 0.58;
        node.x += Math.max(-24, Math.min(24, node.vx));
        node.y += Math.max(-24, Math.min(24, node.vy));
      }
      alpha.current = Math.max(KNOWLEDGE_ALPHA_FLOOR, alpha.current * 0.994);
    };

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const { k, x, y } = transform.current;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(x, y);
      context.scale(k, k);

      const active = hoverRef.current ?? selectedRef.current;
      const near = active === undefined ? undefined : sim.neighbors.get(active);
      const lit = (id: string) => active === undefined || id === active || near?.has(id) === true;

      const left = -x / k;
      const top = -y / k;
      const right = left + width / k;
      const bottom = top + height / k;
      const visible = (node: SimNode) =>
        node.x > left - 80 && node.x < right + 80 && node.y > top - 80 && node.y < bottom + 80;

      for (const pass of [false, true]) {
        context.beginPath();
        context.strokeStyle = pass ? "#a0a0a8" : "#3a3b42";
        context.lineWidth = pass ? Math.max(0.7, 1.5 / k) : Math.max(0.45, 1 / k);
        for (const edge of sim.edges) {
          const isLit = active !== undefined && lit(edge.source.id) && lit(edge.target.id);
          if (isLit !== pass) continue;
          if (!visible(edge.source) && !visible(edge.target)) continue;
          context.moveTo(edge.source.x, edge.source.y);
          context.lineTo(edge.target.x, edge.target.y);
        }
        context.globalAlpha = pass ? 1 : active === undefined ? 0.9 : 0.14;
        context.stroke();
      }
      context.globalAlpha = 1;

      const scale = forcesRef.current.nodeSize;
      const byTone = new Map<string, SimNode[]>();
      for (const node of sim.nodes) {
        if (!visible(node)) continue;
        const tone = knowledgeGroupTone(node.node.group);
        const bucket = byTone.get(tone);
        if (bucket) bucket.push(node);
        else byTone.set(tone, [node]);
      }
      for (const [tone, list] of byTone) {
        for (const dimmed of [true, false]) {
          context.beginPath();
          let drew = false;
          for (const node of list) {
            if ((active !== undefined && !lit(node.id)) !== dimmed) continue;
            drew = true;
            context.moveTo(node.x + node.radius * scale, node.y);
            context.arc(node.x, node.y, node.radius * scale, 0, Math.PI * 2);
          }
          if (!drew) continue;
          context.globalAlpha = dimmed ? 0.16 : 1;
          context.fillStyle = tone;
          context.fill();
        }
      }
      context.globalAlpha = 1;

      // 지나가는 것은 얇은 링, 고른 것은 흰 링. 이웃과 구분되어야 무엇을 보고 있는지 압니다.
      const hovered = hoverRef.current;
      if (hovered !== undefined && hovered !== selectedRef.current) {
        const node = sim.byId.get(hovered);
        if (node) {
          context.beginPath();
          context.arc(node.x, node.y, node.radius * scale + 3 / k, 0, Math.PI * 2);
          context.strokeStyle = "#c3c3c9";
          context.lineWidth = 1.4 / k;
          context.stroke();
        }
      }
      if (selectedRef.current !== undefined) {
        const node = sim.byId.get(selectedRef.current);
        if (node) {
          context.beginPath();
          context.arc(node.x, node.y, node.radius * scale + 3.5 / k, 0, Math.PI * 2);
          context.strokeStyle = "#ededef";
          context.lineWidth = 2.4 / k;
          context.stroke();
        }
      }

      const fadeAt = 0.55 / Math.max(0.15, forcesRef.current.textFade);
      const showLabels = k > fadeAt;
      const opacity = showLabels ? Math.min(1, (k - fadeAt) / (fadeAt * 0.9)) : 1;
      context.font = `${String(11 / k)}px "Pretendard Variable", Pretendard, system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.lineJoin = "round";
      context.lineWidth = 3 / k;
      context.strokeStyle = "#0e0e10";

      /*
       * 겹치면 그리지 않습니다. 지도 렌더러가 하는 것과 같습니다.
       * 이름이 많은 것보다 읽히는 게 낫습니다. 연결이 많은 것부터 자리를 잡습니다.
       *
       * hover·선택한 것의 이름은 **배율과 무관하게 항상** 그립니다 — 축소해서 훑다가
       * 무언가를 발견했을 때 그게 뭔지 알 수 없으면 탐색이 거기서 끊깁니다.
       */
      const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
      const lineHeight = 13 / k;
      const pinned = new Set([selectedRef.current, hoverRef.current].filter((id): id is string => id !== undefined));
      const candidates = sim.nodes
        .filter(
          (node) => visible(node) && (pinned.has(node.id) || (showLabels && (active === undefined || lit(node.id)))),
        )
        .sort((leftNode, rightNode) => {
          const leftKey = pinned.has(leftNode.id) ? 1e9 : leftNode.degree;
          const rightKey = pinned.has(rightNode.id) ? 1e9 : rightNode.degree;
          return rightKey - leftKey;
        });
      for (const node of candidates) {
        if (boxes.length > 140) break;
        const textWidth = context.measureText(node.node.label).width;
        const labelY = node.y + node.radius * scale + 3 / k;
        const box = {
          x0: node.x - textWidth / 2 - 2 / k,
          y0: labelY,
          x1: node.x + textWidth / 2 + 2 / k,
          y1: labelY + lineHeight,
        };
        const collides = boxes.some(
          (other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0,
        );
        if (collides && !pinned.has(node.id)) continue;
        boxes.push(box);
        context.globalAlpha = pinned.has(node.id) ? 1 : opacity;
        context.strokeText(node.node.label, node.x, labelY);
        context.fillStyle = pinned.has(node.id) ? "#ededef" : "#c3c3c9";
        context.fillText(node.node.label, node.x, labelY);
      }
      context.globalAlpha = 1;
      context.restore();
    };

    const loop = () => {
      if (disposed) return;
      if (settleLeft.current > 0) {
        const until = performance.now() + 9;
        let ran = 0;
        while (settleLeft.current > 0 && performance.now() < until) {
          tick();
          settleLeft.current -= 1;
          ran += 1;
          if (ran > 40) break;
        }
        /*
         * 첫 배치를 잡고 나면 카메라를 고정한 채 **정렬되는 모습을 보여줍니다.**
         * 매 프레임 다시 맞추면 화면이 튀고, 아예 안 그리면 검은 화면만 남습니다.
         */
        const tail = settleLeft.current < settleTotal.current * 0.4;
        if (tail) fit();
        setSettling(settleLeft.current);
        if (settleLeft.current === 0) {
          fit();
          /*
           * 완전히 멈추지 않고 아주 낮은 바닥을 남깁니다.
           *
           * 떨림과 표류는 다릅니다. 앞서 거슬렸던 것은 충돌력이 alpha에 안 묶여 생긴
           * **고주파 진동**이었고, 그건 위에서 잡았습니다. 여기서 0으로 얼려버리면 그래프가
           * 그림이 되어 살아 있다는 느낌이 사라집니다. 바닥을 남기면 아주 느리게 숨 쉽니다.
           */
          alpha.current = KNOWLEDGE_ALPHA_FLOOR;
        }
        // 요동치는 앞부분은 그리지 않고, 가라앉는 뒷부분만 보여줍니다.
        if (tail) draw();
        frame = requestAnimationFrame(loop);
        return;
      }
      tick();
      if (dirty.current) {
        draw();
        dirty.current = false;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [sim]);

  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    const { k, x, y } = transform.current;
    return { x: (clientX - box.left - x) / k, y: (clientY - box.top - y) / k };
  };

  /**
   * 커서가 원 **안**에 들어간 노드 중 위에 그려진 것을 고릅니다.
   * 중심 거리 최소로 뽑으면 큰 허브 아래 깔린 작은 노드가 클릭을 가로챕니다.
   */
  const nodeAt = (clientX: number, clientY: number): SimNode | undefined => {
    const point = toWorld(clientX, clientY);
    const scale = forcesRef.current.nodeSize;
    const slack = 4 / transform.current.k;
    for (let i = sim.nodes.length - 1; i >= 0; i -= 1) {
      const node = sim.nodes[i];
      if (!node) continue;
      if (Math.hypot(node.x - point.x, node.y - point.y) <= node.radius * scale + slack) return node;
    }
    return undefined;
  };

  const drag = useRef<{ kind: "pan" | "node"; id?: string; lastX: number; lastY: number; moved: boolean } | undefined>(
    undefined,
  );

  /** 커서는 직접 씁니다. drag를 state로 두면 드래그마다 재렌더가 나 프레임을 먹습니다. */
  const setCursor = (value: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = value;
  };

  const endDrag = () => {
    const state = drag.current;
    drag.current = undefined;
    if (state?.id !== undefined) {
      const node = sim.byId.get(state.id);
      if (node) node.fixed = false;
    }
    setCursor("grab");
    return state;
  };

  const zoomAtCenter = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const anchorX = canvas.clientWidth / 2;
    const anchorY = canvas.clientHeight / 2;
    const current = transform.current;
    const next = Math.min(6, Math.max(0.04, current.k * factor));
    transform.current = {
      k: next,
      x: anchorX - ((anchorX - current.x) / current.k) * next,
      y: anchorY - ((anchorY - current.y) / current.k) * next,
    };
    dirty.current = true;
  };

  return (
    <div className="relative h-full w-full overflow-hidden" ref={wrapRef}>
      <canvas
        aria-describedby="knowledge-graph-help"
        aria-label={`${translate(label)} — ${translate("노드")} ${formatLocalizedNumber(graph.nodes.length)} · ${translate("연결")} ${formatLocalizedNumber(graph.edges.length)}`}
        className="cursor-grab"
        onKeyDown={(event) => {
          const step = event.shiftKey ? 120 : 40;
          const current = transform.current;
          if (event.key === "ArrowLeft") transform.current = { ...current, x: current.x + step };
          else if (event.key === "ArrowRight") transform.current = { ...current, x: current.x - step };
          else if (event.key === "ArrowUp") transform.current = { ...current, y: current.y + step };
          else if (event.key === "ArrowDown") transform.current = { ...current, y: current.y - step };
          else if (event.key === "+" || event.key === "=") zoomAtCenter(1.2);
          else if (event.key === "-") zoomAtCenter(1 / 1.2);
          else if (event.key === "0") fit();
          else return;
          dirty.current = true;
          event.preventDefault();
        }}
        onLostPointerCapture={() => {
          endDrag();
        }}
        onPointerCancel={() => {
          endDrag();
        }}
        onPointerDown={(event) => {
          const found = nodeAt(event.clientX, event.clientY);
          event.currentTarget.setPointerCapture(event.pointerId);
          /*
           * 여기서 노드를 고정하지 않습니다. 누르자마자 고정하면 **그냥 클릭했을 뿐인데**
           * 그 노드가 한두 프레임 물리에서 빠졌다 돌아오면서 주변이 흔들립니다.
           * 고정은 문턱을 넘어 실제로 끌기 시작할 때 합니다.
           */
          drag.current = found
            ? { kind: "node", id: found.id, lastX: event.clientX, lastY: event.clientY, moved: false }
            : { kind: "pan", lastX: event.clientX, lastY: event.clientY, moved: false };
          setCursor("grabbing");
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          // 버튼이 떼어진 채 움직이면 드래그가 끝난 것입니다(pointerup을 놓친 경우).
          if (state && event.buttons === 0) {
            endDrag();
            return;
          }
          if (!state) {
            const found = nodeAt(event.clientX, event.clientY);
            setHoverId(found?.id);
            setCursor(found ? "pointer" : "grab");
            return;
          }
          const dx = event.clientX - state.lastX;
          const dy = event.clientY - state.lastY;
          const startedNow = !state.moved && Math.abs(dx) + Math.abs(dy) > 3;
          if (startedNow) state.moved = true;
          state.lastX = event.clientX;
          state.lastY = event.clientY;
          if (state.kind === "pan") {
            transform.current.x += dx;
            transform.current.y += dy;
            dirty.current = true;
            return;
          }
          const node = state.id === undefined ? undefined : sim.byId.get(state.id);
          if (!node) return;
          // 문턱을 넘기 전에는 물리를 건드리지 않습니다. 클릭 한 번에 그래프가 튀지 않게.
          if (!state.moved) return;
          if (startedNow) node.fixed = true;
          node.x += dx / transform.current.k;
          node.y += dy / transform.current.k;
          alpha.current = Math.max(alpha.current, 0.35);
        }}
        onPointerUp={(event) => {
          const state = endDrag();
          if (!state || state.moved) return;
          onSelect(nodeAt(event.clientX, event.clientY)?.id);
        }}
        onWheel={(event) => {
          // 커서를 기준으로 확대합니다. 화면 중앙 기준이면 보던 곳을 놓칩니다.
          const canvas = canvasRef.current;
          if (!canvas) return;
          const box = canvas.getBoundingClientRect();
          const pointerX = event.clientX - box.left;
          const pointerY = event.clientY - box.top;
          const current = transform.current;
          const next = Math.min(6, Math.max(0.04, current.k * Math.exp(-event.deltaY * 0.0016)));
          transform.current = {
            k: next,
            x: pointerX - ((pointerX - current.x) / current.k) * next,
            y: pointerY - ((pointerY - current.y) / current.k) * next,
          };
          dirty.current = true;
        }}
        ref={canvasRef}
        tabIndex={0}
      />
      <p className="sr-only" id="knowledge-graph-help">
        {translate(
          "드래그로 이동, 휠로 확대·축소. 방향키로 이동하고 Shift로 빠르게. 더하기·빼기로 확대·축소, 0으로 전체 보기. 점을 누르거나 왼쪽의 노드 탐색 목록에서 이름을 선택하면 오른쪽에 자세히 나옵니다.",
        )}
      </p>
      {settling > 0 ? (
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-[5px] border border-border bg-chrome px-2.5 py-1.5">
          <span className="text-[11px] text-muted">{translate("자리를 잡는 중")}</span>
          <span className="h-0.5 w-16 overflow-hidden rounded-full bg-bg-3">
            <span
              className="block h-0.5 bg-fg-3"
              style={{ width: `${String(Math.round((1 - settling / settleTotal.current) * 100))}%` }}
            />
          </span>
        </div>
      ) : null}
      <div className="absolute bottom-3 left-3 flex items-center gap-1">
        {(
          [
            {
              label: "축소",
              sign: "−",
              apply: () => {
                zoomAtCenter(1 / 1.25);
              },
            },
            {
              label: "확대",
              sign: "+",
              apply: () => {
                zoomAtCenter(1.25);
              },
            },
            { label: "전체 보기", sign: "⤢", apply: fit },
          ] as const
        ).map((control) => (
          <button
            aria-label={translate(control.label)}
            className="flex size-7 items-center justify-center rounded-[5px] border border-border bg-chrome text-[12px] text-muted hover:text-primary"
            key={control.label}
            onClick={() => {
              control.apply();
            }}
            type="button"
          >
            {control.sign}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 캔버스와 같은 선택 상태를 공유하는 키보드·스크린 리더용 정본 노드 목록입니다. */
export function KnowledgeNodeExplorer({
  graph,
  onSelect,
  selectedId,
}: {
  graph: KnowledgeGraphView;
  onSelect: (nodeId: string) => void;
  selectedId: string | undefined;
}) {
  const { locale } = useI18n();
  const collator = new Intl.Collator(localeTag(locale));
  const nodes = [...graph.nodes]
    .sort(
      (left, right) =>
        collator.compare(left.label, right.label) ||
        (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0),
    )
    .slice(0, 200);
  if (nodes.length === 0) return null;
  return (
    <details className="group border-b border-border">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] text-secondary outline-none marker:hidden hover:text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-fg-2 [&::-webkit-details-marker]:hidden"
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          const details = event.currentTarget.parentElement;
          if (details instanceof HTMLDetailsElement) details.open = !details.open;
        }}
        tabIndex={0}
      >
        <span className="min-w-0 flex-1 font-medium">{translate("노드 탐색")}</span>
        <span className="shrink-0 tabular-nums text-muted">{formatLocalizedNumber(nodes.length)}</span>
        <span aria-hidden="true" className="text-muted group-open:rotate-90">
          ›
        </span>
      </summary>
      <ul aria-label={translate("지도 노드")} className="max-h-52 overflow-y-auto border-t border-border py-1">
        {nodes.map((node) => {
          const selected = node.nodeId === selectedId;
          return (
            <li key={node.nodeId}>
              <button
                aria-label={`${translate("지도에서 선택:")} ${node.label}`}
                aria-pressed={selected}
                className={`relative flex w-full items-center px-3 py-1.5 text-left text-[11px] outline-none hover:bg-surface-1 hover:text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-fg-2 ${
                  selected
                    ? "bg-surface-2 text-primary before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
                    : "text-secondary"
                }`}
                onClick={() => {
                  onSelect(node.nodeId);
                }}
                type="button"
              >
                <span className="truncate">{node.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** 색이 뜻을 가지므로 범례가 있어야 합니다. 없으면 여덟 색은 정보가 아니라 소음입니다. */
export function KnowledgeGroupLegend({ graph }: { graph: KnowledgeGraphView }) {
  const groups = new Map<string, number>();
  for (const node of graph.nodes) groups.set(node.group ?? "그 밖", (groups.get(node.group ?? "그 밖") ?? 0) + 1);
  const rows = [...groups].sort((left, right) => right[1] - left[1]).slice(0, 10);
  if (rows.length < 2) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{translate("색은 폴더")}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map(([group, count]) => (
          <li className="flex items-center gap-2 text-[11px]" key={group}>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: knowledgeGroupTone(group === "그 밖" ? undefined : group) }}
            />
            <span className="min-w-0 flex-1 truncate text-secondary">{group}</span>
            <span className="shrink-0 tabular-nums text-muted">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 힘 조절. 옵시디언의 Forces 패널과 같은 넷 + 표시 둘. */
export function KnowledgeForcePanel({
  forces,
  onChange,
}: {
  forces: KnowledgeForceSettings;
  onChange: (next: KnowledgeForceSettings) => void;
}) {
  const rows: readonly { key: keyof KnowledgeForceSettings; label: string; min: number; max: number; step: number }[] =
    [
      { key: "center", label: "중심으로 모으기", min: 0, max: 1, step: 0.05 },
      { key: "repel", label: "서로 밀어내기", min: 0.2, max: 3, step: 0.1 },
      { key: "link", label: "연결이 당기기", min: 0.1, max: 2, step: 0.1 },
      { key: "distance", label: "연결 길이", min: 20, max: 180, step: 5 },
      { key: "textFade", label: "이름 보이기", min: 0.2, max: 3, step: 0.1 },
      { key: "nodeSize", label: "점 크기", min: 0.5, max: 2.5, step: 0.1 },
    ];
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <label className="block" key={row.key}>
          <span className="flex items-baseline justify-between text-[11px] text-muted">
            {row.label}
            <span className="tabular-nums">{forces[row.key]}</span>
          </span>
          <input
            className="mt-0.5 h-1 w-full accent-fg-2"
            max={row.max}
            min={row.min}
            onChange={(event) => {
              onChange({ ...forces, [row.key]: Number(event.target.value) });
            }}
            step={row.step}
            type="range"
            value={forces[row.key]}
          />
        </label>
      ))}
    </div>
  );
}
