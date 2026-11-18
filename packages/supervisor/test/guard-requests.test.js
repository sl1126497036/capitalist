/**
 * 越界与删除申请的台账。
 *
 * 守三件事：批准按动作与路径集合绑定；一次批准只用一次；补理由不改变待裁决状态。
 * 这三条是“一次一批准”的全部判据，任一条退化都会让批准变成时间窗内的通行证。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  appendDecision,
  appendReason,
  appendRequest,
  approvedFor,
  fingerprintOf,
  findOpenByFingerprint,
  markGuardUsed,
  newGuardId,
  openGuardRequests,
  reasonedGuardRequests,
  readGuardRequests,
} = require("../dist/core/guard/requests");

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), "capitalist-guard-req-"));
  mkdirSync(join(dir, ".capitalist"), { recursive: true });
  return dir;
}

function add(root, paths, action = "write", kind = "outside") {
  const id = newGuardId();
  appendRequest(root, {
    id,
    at: new Date().toISOString(),
    atTs: Date.now() / 1000,
    kind,
    action,
    tool: "Bash",
    command: "echo x > /tmp/x",
    paths,
    worker: "1",
    dispatch: "d1",
    stage: "S1",
  });
  return id;
}

test("指纹与路径顺序、重复无关", () => {
  const a = fingerprintOf("outside", "write", ["/tmp/a", "/tmp/b"]);
  const b = fingerprintOf("outside", "write", ["/tmp/b", "/tmp/a", "/tmp/a"]);
  assert.strictEqual(a, b);
});

test("动作不同则指纹不同，读的批准不能用于写", () => {
  assert.notStrictEqual(
    fingerprintOf("outside", "read", ["/tmp/a"]),
    fingerprintOf("outside", "write", ["/tmp/a"]),
  );
});

test("新申请处于待裁决，补理由后进入可裁决集合", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"]);
  assert.deepStrictEqual(openGuardRequests(root).map((r) => r.id), [id]);
  assert.deepStrictEqual(reasonedGuardRequests(root), []);

  appendReason(root, id, "核对构建配置");
  assert.deepStrictEqual(reasonedGuardRequests(root).map((r) => r.id), [id]);
  assert.strictEqual(readGuardRequests(root)[0].reason, "核对构建配置");
});

test("补理由时可合并路径，一条申请覆盖整批操作", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"]);
  appendReason(root, id, "同一批迁移", ["/tmp/a", "/tmp/b"]);
  assert.deepStrictEqual(readGuardRequests(root)[0].paths, ["/tmp/a", "/tmp/b"]);
});

test("批准命中相同动作与路径，使用一次后失效", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a", "/tmp/b"]);
  assert.strictEqual(approvedFor(root, "outside", "write", ["/tmp/b", "/tmp/a"]), null);

  appendDecision(root, id, "allow", "supervisor", "与派单目标一致");
  const hit = approvedFor(root, "outside", "write", ["/tmp/a", "/tmp/b"]);
  assert.ok(hit);
  assert.strictEqual(hit.id, id);

  markGuardUsed(root, id);
  assert.strictEqual(approvedFor(root, "outside", "write", ["/tmp/a", "/tmp/b"]), null);
});

test("拒绝不产生批准", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"]);
  appendDecision(root, id, "deny", "supervisor", "与目标无关", "改用项目内的配置");
  assert.strictEqual(approvedFor(root, "outside", "write", ["/tmp/a"]), null);
  assert.strictEqual(readGuardRequests(root)[0].alternative, "改用项目内的配置");
});

test("转用户裁决不是批准", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"]);
  appendDecision(root, id, "escalate", "supervisor", "拿不准");
  assert.strictEqual(readGuardRequests(root)[0].status, "escalated");
  assert.strictEqual(approvedFor(root, "outside", "write", ["/tmp/a"]), null);
});

test("同一指纹的待裁决申请不重复入队", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"]);
  const fp = fingerprintOf("outside", "write", ["/tmp/a"]);
  assert.strictEqual(findOpenByFingerprint(root, fp)?.id, id);
});

test("删除申请与越界申请互不覆盖", () => {
  const root = tmpRoot();
  const id = add(root, ["/tmp/a"], "delete", "delete");
  appendDecision(root, id, "allow", "supervisor", "确认是临时产物");
  assert.ok(approvedFor(root, "delete", "delete", ["/tmp/a"]));
  assert.strictEqual(approvedFor(root, "outside", "delete", ["/tmp/a"]), null);
});
