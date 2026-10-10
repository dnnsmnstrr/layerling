import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  cleanImportLinkName,
  fetchImportLinkFile,
  IMPORT_LINK_MAX_STL_BYTES,
  importLinkStlFile,
  ImportLinkError,
  readImportLink,
  stlImportLink,
} from "@/lib/importLink";
import { importedShapeFromStl } from "@/lib/stlImport";

function binaryStl(triangles: number[][][]) {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    const offset = 84 + index * 50 + 12;
    triangle.forEach((point, corner) => point.forEach((value, axis) => view.setFloat32(offset + corner * 12 + axis * 4, value, true)));
  });
  return new Uint8Array(buffer);
}

const TETRAHEDRON = binaryStl([
  [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
  [[0, 0, 0], [0, 10, 0], [0, 0, 10]],
  [[0, 0, 0], [0, 0, 10], [10, 0, 0]],
  [[10, 0, 0], [0, 0, 10], [0, 10, 0]],
]);

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof ImportLinkError ? error.code : String(error);
  }
  return "no error";
}

function hashOf(link: string) {
  return new URL(link).hash;
}

describe("import links", () => {
  it("carries an STL through a link unchanged, with its name", () => {
    const link = stlImportLink("https://layerling.example/?editor=1&project=abc", TETRAHEDRON, "Bracket v2");
    expect(link.startsWith("https://layerling.example/#name=Bracket+v2&import=stl:")).toBe(true);
    const read = readImportLink(hashOf(link));
    expect(read).toMatchObject({ kind: "stl", name: "Bracket v2" });
    expect(read?.kind === "stl" && Array.from(read.bytes)).toEqual(Array.from(TETRAHEDRON));
  });

  it("hands the STL to the usual importer as a file named after the design", async () => {
    const read = readImportLink(hashOf(stlImportLink("https://layerling.example/", TETRAHEDRON, "Bracket")));
    if (read?.kind !== "stl") throw new Error("expected an STL link");
    const file = importLinkStlFile(read, "Linked model");
    expect(file.name).toBe("Bracket.stl");
    const shape = importedShapeFromStl(file.name, await file.arrayBuffer());
    expect(shape.importedMesh?.positions.length).toBe(4 * 9);
  });

  it("names a link without a name after the fallback", () => {
    const read = readImportLink(hashOf(stlImportLink("https://layerling.example/", TETRAHEDRON, "  ")));
    if (read?.kind !== "stl") throw new Error("expected an STL link");
    expect(importLinkStlFile(read, "Linked model").name).toBe("Linked model.stl");
  });

  it("ignores fragments that hold no import", () => {
    expect(readImportLink("")).toBeNull();
    expect(readImportLink("#section-3")).toBeNull();
    expect(readImportLink("#name=x&reimport=stl:AAAA")).toBeNull();
  });

  it("refuses a damaged or cut-off link", () => {
    const hash = hashOf(stlImportLink("https://layerling.example/", TETRAHEDRON, "Bracket"));
    expect(code(() => readImportLink(hash.slice(0, hash.length - 20)))).toBe("damaged");
    expect(code(() => readImportLink("#import=stl:"))).toBe("damaged");
    expect(code(() => readImportLink("#import=stl:not*base64"))).toBe("damaged");
    expect(code(() => readImportLink("#import=nonsense"))).toBe("damaged");
  });

  it("stops inflating a small link that would grow past the limit", () => {
    const bomb = deflateSync(new Uint8Array(IMPORT_LINK_MAX_STL_BYTES + 1024), { level: 9 });
    const base64 = Buffer.from(bomb).toString("base64url");
    expect(base64.length).toBeLessThan(200_000);
    expect(code(() => readImportLink(`#import=stl:${base64}`))).toBe("tooLarge");
  });

  it("refuses to hand out a link longer than the limit", () => {
    expect(code(() => stlImportLink("https://layerling.example/", TETRAHEDRON, "Bracket", 50))).toBe("tooLarge");
  });

  it("cleans names from a link", () => {
    expect(cleanImportLinkName("../../etc/passwd")).toBe(".. .. etc passwd");
    expect(cleanImportLinkName("a\u0000b\nc")).toBe("a b c");
    expect(cleanImportLinkName("x".repeat(200))).toHaveLength(80);
  });

  it("reads an address, plain or encoded, with its own query", () => {
    expect(readImportLink("#import=https://files.example/parts/clip.stl?v=2&dl=1")).toEqual({
      kind: "url",
      name: "",
      url: "https://files.example/parts/clip.stl?v=2&dl=1",
    });
    expect(readImportLink(`#name=Clip&import=${encodeURIComponent("https://files.example/clip.stl?v=2")}`)).toEqual({
      kind: "url",
      name: "Clip",
      url: "https://files.example/clip.stl?v=2",
    });
    expect(code(() => readImportLink("#import=javascript:alert(1)"))).toBe("unsupported");
    expect(code(() => readImportLink("#import=file:///etc/passwd"))).toBe("unsupported");
  });
});

describe("fetched import links", () => {
  const respond = (body: BodyInit, init?: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;

  it("fetches without cookies and names the file from the address", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(TETRAHEDRON as BodyInit);
    }) as unknown as typeof fetch;
    const file = await fetchImportLinkFile({ kind: "url", name: "", url: "https://files.example/parts/clip%20v2.3mf" }, "Linked model", fetchImpl);
    expect(file.name).toBe("clip v2.3mf");
    expect(seen).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("assumes STL when the address names no model format", async () => {
    const file = await fetchImportLinkFile({ kind: "url", name: "Clip", url: "https://files.example/download.php?id=7" }, "Linked model", respond(TETRAHEDRON as BodyInit));
    expect(file.name).toBe("Clip.stl");
  });

  it("refuses design files and backups", async () => {
    for (const url of ["https://files.example/a.lyl", "https://files.example/backup.zip"]) {
      await expect(fetchImportLinkFile({ kind: "url", name: "", url }, "Linked model", respond("x"))).rejects.toMatchObject({ code: "unsupported" });
    }
  });

  it("says when the file cannot be fetched", async () => {
    const refused = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const link = { kind: "url" as const, name: "", url: "https://files.example/a.stl" };
    await expect(fetchImportLinkFile(link, "Linked model", refused)).rejects.toMatchObject({ code: "fetchFailed" });
    await expect(fetchImportLinkFile(link, "Linked model", respond("", { status: 404 }))).rejects.toMatchObject({ code: "fetchFailed" });
    await expect(fetchImportLinkFile(link, "Linked model", respond("", { headers: { "content-length": String(1024 ** 3) } }))).rejects.toMatchObject({ code: "tooLarge" });
  });
});
