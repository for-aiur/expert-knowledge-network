-- NULL preserves unknown language for existing records and multilingual content.
ALTER TABLE workflow_submissions ADD COLUMN content_language TEXT
  CHECK (content_language IS NULL OR (
    length(content_language) BETWEEN 2 AND 35
    AND content_language NOT GLOB '*[^A-Za-z0-9-]*'
    AND content_language GLOB '[A-Za-z][A-Za-z]*'
  ));
