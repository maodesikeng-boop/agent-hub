ALTER TABLE task_graph_steps
  ADD COLUMN checkpoint TEXT CHECK (checkpoint IS NULL OR checkpoint IN ('user', 'pm'));

UPDATE task_graph_steps
   SET checkpoint = 'user'
 WHERE confirm = 1 AND checkpoint IS NULL;
