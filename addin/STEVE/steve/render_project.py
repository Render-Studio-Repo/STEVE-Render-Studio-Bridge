"""Small persistent domain object for one origin's Render project binding."""
from dataclasses import dataclass, asdict
import json
import os
import tempfile
from uuid import UUID, uuid4


@dataclass(frozen=True)
class ProjectBinding:
    renderUserId: str
    renderProjectId: str
    revision: str

    @classmethod
    def create(cls, user, project):
        return cls(user, project, uuid4().hex)

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or set(value) != {'renderUserId', 'renderProjectId', 'revision'}:
            raise ValueError('Invalid project binding')
        for key in ('renderUserId', 'renderProjectId'):
            if not isinstance(value[key], str) or not value[key].strip() or len(value[key]) > 256:
                raise ValueError('Invalid project owner')
        if not isinstance(value['revision'], str) or UUID(value['revision']).hex != value['revision']:
            raise ValueError('Invalid binding revision')
        return cls(**value)

    def public(self):
        return asdict(self)


class RenderProject:
    def __init__(self, path, origin, owners):
        self.path, self.origin = path, origin
        self.binding = None
        self.error = False
        try:
            if path and (path.exists() or path.is_symlink()):
                if path.is_symlink() or path.stat().st_mode & 0o077 or (hasattr(os, 'getuid') and path.stat().st_uid != os.getuid()):
                    raise ValueError('Project file must be owner-private')
                saved = json.loads(path.read_text(encoding='utf-8'))
                if not isinstance(saved, dict) or set(saved) != {'version', 'renderOrigin', 'binding'} or saved['version'] != 1:
                    raise ValueError('Invalid project file')
                if not isinstance(saved['renderOrigin'], str) or not saved['renderOrigin']:
                    raise ValueError('Invalid project origin')
                binding = ProjectBinding.parse(saved['binding']) if saved['binding'] is not None else None
                if saved['renderOrigin'] == origin:
                    self.binding = binding
                else:
                    # Persist revocation so returning to an earlier origin cannot revive it.
                    self.replace(None)
            elif len(owners) == 1:
                user, project = next(iter(owners))
                self.replace(ProjectBinding.parse(ProjectBinding.create(user, project).public()))
        except (OSError, ValueError, TypeError, AttributeError):
            self.error = True

    def replace(self, binding, origin=None):
        origin = origin or self.origin
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.render-project-', dir=self.path.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump({'version': 1, 'renderOrigin': origin, 'binding': binding.public() if binding else None}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        self.binding, self.origin, self.error = binding, origin, False
