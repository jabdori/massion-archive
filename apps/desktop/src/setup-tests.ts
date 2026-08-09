import "@testing-library/jest-dom/vitest";

// jsdom에는 레이아웃이 없어 scrollIntoView가 아예 없습니다. 구조에서 고른 노드를 보이게 하는
// 스크롤은 브라우저에서만 뜻이 있으므로 여기서는 아무 일도 하지 않게 둡니다.
Element.prototype.scrollIntoView = () => {};

localStorage.setItem("massion.language.v1", "ko");

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
