import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("verlezza_release",ROOT/"scripts"/"verify_verlezza_release.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ScudoReleaseContracts(unittest.TestCase):
    def manifest(self):
        return {
          "schema_version":1,"version_code":200,"version_name":"1.7.271",
          "apk_sha256":"a"*64,
          "archive_url":"https://sdmntpr-test.oaiusercontent.com/files/11111111-1111-1111-1111-111111111111/raw",
          "source":{"repository":"Br174/Visionflix","ref":"refs/heads/main",
            "commit":"b"*40,"run_id":100,"artifact_id":200,"artifact_sha256":"c"*64}
        }
    def badging(self):
        return ("package: name='com.br174.visionflix.tv.debug' versionCode='200' versionName='1.7.271'\n"
                "sdkVersion:'21'\napplication-label:'Verlezza Vision'\n"
                "leanback-launchable-activity: name='com.streamflixreborn.streamflix.activities.main.MainTvActivity'\n")
    def test_valid_source_and_checksum_contract(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"release.json";p.write_text(json.dumps(self.manifest()))
            self.assertEqual(module.read_manifest(p)["version_code"],200)
    def test_reject_untrusted_archive_or_source(self):
        with tempfile.TemporaryDirectory() as td:
            m=self.manifest();m["archive_url"]="https://evil.example.com/payload.apk"
            p=Path(td)/"release.json";p.write_text(json.dumps(m))
            with self.assertRaises(ValueError):module.read_manifest(p)
            m=self.manifest();m["source"]["repository"]="untrusted/other"
            p.write_text(json.dumps(m))
            with self.assertRaises(ValueError):module.read_manifest(p)
    def test_signed_tv_verification_passes_exact_expected_certificate(self):
        sig="certificate SHA-256 digest: "+module.CERTIFICATE+"\n"
        module.verify_android(self.manifest(),self.badging(),sig)
    def test_wrong_certificate_or_package_fails_closed(self):
        sig="certificate SHA-256 digest: "+("0"*64)+"\n"
        with self.assertRaises(ValueError):module.verify_android(self.manifest(),self.badging(),sig)
        with self.assertRaises(ValueError):module.verify_android(self.manifest(),"package: name='bad'\n","certificate SHA-256 digest: "+module.CERTIFICATE)
    def test_version_supersession_and_duplicate_release(self):
        m=self.manifest()
        self.assertEqual(module.release_action(m,{"tag_name":"verlezza-tv-201"}),"superseded")
        self.assertEqual(module.release_action(m,{"tag_name":"verlezza-tv-200"}),"already_latest")
        self.assertEqual(module.release_action(m,{"tag_name":"verlezza-tv-199"}),"publish")

if __name__=="__main__":unittest.main()
