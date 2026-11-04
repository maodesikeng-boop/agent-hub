-- 0005_project_setup：每个项目一条 worktree 准备命令（hub project setup）。约定同 0001～0004。
-- 守护进程给 Worker 建好 worktree 后在里面用 shell 跑它，跑完 Worker 再开工（src/daemon/setup/setup.ts）。
-- NULL = 没配，什么也不跑；老项目升级后都是 NULL。只加一列，不用重建表，老数据一行不动。
ALTER TABLE projects ADD COLUMN setup_command TEXT;
