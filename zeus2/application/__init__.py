"""Application-facing services for the Zeus web interface.

The modules in this package translate HTTP/UI requests into the existing
transactional Zeus core.  They deliberately contain no browser or socket
code, which keeps the business rules usable from tests and future clients.
"""
