"""Confluence Cloud publishing (Task 14, issue #57, ADR-029 (fork)).

- ``storage`` — markdown → Confluence storage format (XHTML) converter.
- ``client`` — the small Confluence v2 REST client the ``confluence`` /
  ``s3_and_confluence`` deliverers (``workflow.deliverers``) use, including the
  read-back Task 15 needs.
"""
