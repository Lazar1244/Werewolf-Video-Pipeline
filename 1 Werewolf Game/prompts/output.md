# Answer format
Reply with ONE JSON object only (no code fence, no text before or after it). It must match this JSON schema:
{{schema}}
Field order: "{{thoughts_field}}" first (at most {{reasoning_words}} words), then "notebook" (at most {{notebook_words}} words, or null to keep your previous notebook), then the task fields.
