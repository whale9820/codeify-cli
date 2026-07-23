.PHONY: install-local test check

install-local:
	uv tool install --editable . --force

test:
	PYTHONPATH=src python3 -m unittest discover -s tests -v

check:
	python3 -m compileall -q src tests
	PYTHONPATH=src python3 -m unittest discover -s tests -v
