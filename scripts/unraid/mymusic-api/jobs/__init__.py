"""The long jobs the Worker can start: import (Organize), enrich and youtube."""
from jobs.enrich import run_enrich
from jobs.importer import run_import
from jobs.youtube import run_youtube

JOBS = {"import": run_import, "enrich": run_enrich, "youtube": run_youtube}
