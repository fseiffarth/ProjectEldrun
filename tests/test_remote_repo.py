"""Tests for remote repository creation (create_remote_repo, _git_has_remote)
and the related git_profile_url / git_token settings defaults."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch, call
from urllib.error import HTTPError
import io

# ---------------------------------------------------------------------------
# Stub gi before importing project_manager
# ---------------------------------------------------------------------------
gi_mock = MagicMock()
gi_mock.repository.GLib.get_user_data_dir.return_value = "/tmp/eldrun_test_remote"
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import project_manager as _pm


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_http_response(body: dict, status: int = 200):
    """Return a mock context-manager response for urllib.request.urlopen."""
    encoded = json.dumps(body).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = encoded
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _completed(returncode: int = 0):
    m = MagicMock()
    m.returncode = returncode
    return m


# ---------------------------------------------------------------------------
# _git_has_remote
# ---------------------------------------------------------------------------

class TestGitHasRemote(unittest.TestCase):

    def test_returns_true_when_remote_exists(self):
        with patch("project_manager.subprocess.run", return_value=_completed(0)):
            self.assertTrue(_pm._git_has_remote("/some/dir"))

    def test_returns_false_when_no_remote(self):
        with patch("project_manager.subprocess.run", return_value=_completed(1)):
            self.assertFalse(_pm._git_has_remote("/some/dir"))

    def test_returns_false_on_exception(self):
        with patch("project_manager.subprocess.run", side_effect=OSError("no git")):
            self.assertFalse(_pm._git_has_remote("/some/dir"))

    def test_calls_correct_git_command(self):
        with patch("project_manager.subprocess.run", return_value=_completed(0)) as mock_run:
            _pm._git_has_remote("/repo")
            mock_run.assert_called_once()
            args = mock_run.call_args[0][0]
            self.assertEqual(args, ["git", "remote", "get-url", "origin"])


# ---------------------------------------------------------------------------
# create_remote_repo — GitHub
# ---------------------------------------------------------------------------

class TestCreateRemoteRepoGitHub(unittest.TestCase):

    def _run(self, git_type="private", repo_name="my-project",
             profile_url="https://github.com/testuser", token="ghp_abc123",
             api_response=None):
        if api_response is None:
            api_response = {
                "clone_url": "https://github.com/testuser/my-project.git",
                "ssh_url": "git@github.com:testuser/my-project.git",
            }
        resp_mock = _make_http_response(api_response)

        with patch("urllib.request.urlopen", return_value=resp_mock) as mock_open, \
             patch("urllib.request.Request") as mock_req, \
             patch("project_manager.subprocess.run", return_value=_completed(0)) as mock_sub:
            result = _pm.create_remote_repo(
                "/fake/dir", repo_name, git_type, profile_url, token
            )
        return result, mock_open, mock_req, mock_sub

    def test_returns_clone_url(self):
        url, *_ = self._run()
        self.assertEqual(url, "https://github.com/testuser/my-project.git")

    def test_uses_github_api_endpoint(self):
        _, _, mock_req, _ = self._run()
        call_args = mock_req.call_args
        self.assertIn("api.github.com/user/repos", call_args[0][0])

    def test_sets_authorization_header(self):
        _, _, mock_req, _ = self._run(token="ghp_xyz")
        headers = mock_req.call_args[1]["headers"]
        self.assertIn("Authorization", headers)
        self.assertIn("ghp_xyz", headers["Authorization"])

    def test_private_repo_payload(self):
        _, _, mock_req, _ = self._run(git_type="private")
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertTrue(payload["private"])

    def test_public_repo_payload(self):
        _, _, mock_req, _ = self._run(git_type="public")
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertFalse(payload["private"])

    def test_auto_init_false(self):
        _, _, mock_req, _ = self._run()
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertFalse(payload.get("auto_init", True))

    def test_git_remote_add_called(self):
        _, _, _, mock_sub = self._run()
        cmds = [c[0][0] for c in mock_sub.call_args_list]
        self.assertTrue(
            any(c[:3] == ["git", "remote", "add"] for c in cmds),
            "Expected git remote add call"
        )

    def test_git_remote_add_uses_clone_url(self):
        _, _, _, mock_sub = self._run()
        remote_add = next(
            c[0][0] for c in mock_sub.call_args_list
            if c[0][0][:3] == ["git", "remote", "add"]
        )
        self.assertIn("https://github.com/testuser/my-project.git", remote_add)

    def test_git_push_called(self):
        _, _, _, mock_sub = self._run()
        cmds = [c[0][0] for c in mock_sub.call_args_list]
        self.assertTrue(
            any("push" in c for c in cmds),
            "Expected git push call"
        )

    def test_git_push_failure_does_not_raise(self):
        # push is best-effort; a non-zero return code must not raise
        def _side_effect(cmd, **kwargs):
            if "push" in cmd:
                return _completed(1)
            return _completed(0)

        resp = _make_http_response({
            "clone_url": "https://github.com/u/r.git"
        })
        with patch("urllib.request.urlopen", return_value=resp), \
             patch("urllib.request.Request"), \
             patch("project_manager.subprocess.run", side_effect=_side_effect):
            # Must not raise
            _pm.create_remote_repo(
                "/fake/dir", "r", "private",
                "https://github.com/u", "tok"
            )

    def test_uses_post_method(self):
        _, _, mock_req, _ = self._run()
        self.assertEqual(mock_req.call_args[1].get("method"), "POST")

    def test_api_http_error_propagates(self):
        import warnings
        err = HTTPError(
            "https://api.github.com/user/repos", 401,
            "Unauthorized", {}, io.BytesIO(b"")
        )
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            with patch("urllib.request.urlopen", side_effect=err), \
                 patch("urllib.request.Request"):
                with self.assertRaises(HTTPError):
                    _pm.create_remote_repo(
                        "/fake/dir", "r", "private",
                        "https://github.com/user", "bad_token"
                    )


# ---------------------------------------------------------------------------
# create_remote_repo — GitLab
# ---------------------------------------------------------------------------

class TestCreateRemoteRepoGitLab(unittest.TestCase):

    def _run(self, git_type="private", repo_name="my-proj",
             profile_url="https://gitlab.com/testuser", token="glpat-abc",
             api_response=None):
        if api_response is None:
            api_response = {
                "http_url_to_repo": "https://gitlab.com/testuser/my-proj.git",
            }
        resp_mock = _make_http_response(api_response)

        with patch("urllib.request.urlopen", return_value=resp_mock) as mock_open, \
             patch("urllib.request.Request") as mock_req, \
             patch("project_manager.subprocess.run", return_value=_completed(0)) as mock_sub:
            result = _pm.create_remote_repo(
                "/fake/dir", repo_name, git_type, profile_url, token
            )
        return result, mock_open, mock_req, mock_sub

    def test_returns_http_url(self):
        url, *_ = self._run()
        self.assertEqual(url, "https://gitlab.com/testuser/my-proj.git")

    def test_uses_gitlab_api_endpoint(self):
        _, _, mock_req, _ = self._run()
        endpoint = mock_req.call_args[0][0]
        self.assertIn("/api/v4/projects", endpoint)

    def test_private_token_header(self):
        _, _, mock_req, _ = self._run(token="glpat-xyz")
        headers = mock_req.call_args[1]["headers"]
        self.assertIn("PRIVATE-TOKEN", headers)
        self.assertEqual(headers["PRIVATE-TOKEN"], "glpat-xyz")

    def test_private_visibility_payload(self):
        _, _, mock_req, _ = self._run(git_type="private")
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertEqual(payload["visibility"], "private")

    def test_public_visibility_payload(self):
        _, _, mock_req, _ = self._run(git_type="public")
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertEqual(payload["visibility"], "public")

    def test_self_hosted_gitlab_uses_correct_host(self):
        resp = _make_http_response({
            "http_url_to_repo": "https://git.example.com/user/repo.git"
        })
        with patch("urllib.request.urlopen", return_value=resp), \
             patch("urllib.request.Request") as mock_req, \
             patch("project_manager.subprocess.run", return_value=_completed(0)):
            _pm.create_remote_repo(
                "/fake/dir", "repo", "private",
                "https://git.example.com/user", "token"
            )
        endpoint = mock_req.call_args[0][0]
        self.assertTrue(endpoint.startswith("https://git.example.com/"))

    def test_git_remote_add_called(self):
        _, _, _, mock_sub = self._run()
        cmds = [c[0][0] for c in mock_sub.call_args_list]
        self.assertTrue(any(c[:3] == ["git", "remote", "add"] for c in cmds))

    def test_post_method(self):
        _, _, mock_req, _ = self._run()
        self.assertEqual(mock_req.call_args[1].get("method"), "POST")

    def test_initialize_with_readme_false(self):
        _, _, mock_req, _ = self._run()
        payload = json.loads(mock_req.call_args[1]["data"])
        self.assertFalse(payload.get("initialize_with_readme", True))


# ---------------------------------------------------------------------------
# create_remote_repo — git subprocess error propagates
# ---------------------------------------------------------------------------

class TestCreateRemoteRepoSubprocessError(unittest.TestCase):

    def test_git_remote_add_failure_raises(self):
        import subprocess
        resp = _make_http_response({
            "clone_url": "https://github.com/u/r.git"
        })

        def _side_effect(cmd, **kwargs):
            if cmd[:3] == ["git", "remote", "add"]:
                raise subprocess.CalledProcessError(128, cmd)
            return _completed(0)

        with patch("urllib.request.urlopen", return_value=resp), \
             patch("urllib.request.Request"), \
             patch("project_manager.subprocess.run", side_effect=_side_effect):
            with self.assertRaises(Exception):
                _pm.create_remote_repo(
                    "/fake/dir", "r", "private",
                    "https://github.com/u", "tok"
                )


# ---------------------------------------------------------------------------
# Settings defaults for git hosting
# ---------------------------------------------------------------------------

class TestGitHostingSettingsDefaults(unittest.TestCase):

    def _make_manager(self, data_dir: str):
        import importlib
        import settings_manager as sm
        importlib.reload(sm)
        sm._SETTINGS_FILE = os.path.join(data_dir, "settings.json")
        return sm.SettingsManager()

    def test_git_profile_url_default_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            mgr = self._make_manager(d)
            self.assertEqual(mgr.get("git_profile_url"), "")

    def test_git_token_default_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            mgr = self._make_manager(d)
            self.assertEqual(mgr.get("git_token"), "")

    def test_git_profile_url_persisted(self):
        with tempfile.TemporaryDirectory() as d:
            import settings_manager as sm
            mgr = self._make_manager(d)
            mgr.set("git_profile_url", "https://github.com/alice")
            mgr2 = self._make_manager(d)
            self.assertEqual(mgr2.get("git_profile_url"), "https://github.com/alice")

    def test_git_token_persisted(self):
        with tempfile.TemporaryDirectory() as d:
            mgr = self._make_manager(d)
            mgr.set("git_token", "ghp_secret123")
            mgr2 = self._make_manager(d)
            self.assertEqual(mgr2.get("git_token"), "ghp_secret123")

    def test_existing_settings_not_overwritten_by_defaults(self):
        """Loading a settings file that already has other keys keeps them."""
        with tempfile.TemporaryDirectory() as d:
            import settings_manager as sm
            path = os.path.join(d, "settings.json")
            with open(path, "w") as f:
                json.dump({"terminal_command": "codex"}, f)
            mgr = self._make_manager(d)
            self.assertEqual(mgr.get("terminal_command"), "codex")
            # defaults for new keys still apply
            self.assertEqual(mgr.get("git_profile_url"), "")


if __name__ == "__main__":
    unittest.main()
