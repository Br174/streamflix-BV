#!/usr/bin/env python3
"""Validate the narrowly scoped Verlezza Vision TV release manifest and APK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse
import zipfile

APK_NAME = 'Visionflix_BV_TV.apk'
BUILD_ARTIFACT_TV_NAME = 'Verlezza-Vision-TV.apk'
CERTIFICATE = '55d9c2dc94f32e6b7685994f2652eec3d8086432e9de94e0645a8bf30f41918e'
PACKAGE = 'com.br174.visionflix.tv.debug'
ACTIVITY = 'com.streamflixreborn.streamflix.activities.main.MainTvActivity'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_manifest(path):
    m = json.loads(Path(path).read_text())
    require(m.get('schema_version') == 1, 'Unsupported manifest schema')
    code = m.get('version_code')
    require(type(code) is int and 168 <= code <= 2100000000, 'Invalid Android version code')
    require(re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', m.get('version_name', '')), 'Invalid version name')
    require(re.fullmatch(r'[0-9a-f]{64}', m.get('apk_sha256', '')), 'Invalid APK checksum')

    archive_url = m.get('archive_url', '')
    parsed = urlparse(archive_url)
    allowed_archive = False
    if parsed.scheme == 'https' and parsed.hostname == 'd2ol7oe51mr4n9.cloudfront.net':
        allowed_archive = bool(re.fullmatch(r'/user_[A-Za-z0-9]+/[0-9a-f-]{36}\.zip', parsed.path))
    elif parsed.scheme == 'https' and parsed.hostname == 'sdmntprdenmarkeast.oaiusercontent.com':
        allowed_archive = bool(re.fullmatch(r'/files/[0-9a-f-]+/raw', parsed.path))
    require(allowed_archive, 'Unexpected archive URL')

    source = m.get('source', {})
    require(source.get('repository') == 'Br174/Visionflix', 'Unexpected source repository')
    require(source.get('ref') == 'refs/heads/main', 'Only source main builds may be published')
    require(re.fullmatch(r'[0-9a-f]{40}', source.get('commit', '')), 'Invalid source commit')
    for field in ('run_id', 'artifact_id'):
        require(type(source.get(field)) is int and source[field] > 0, 'Invalid source ' + field)
    require(re.fullmatch(r'[0-9a-f]{64}', source.get('artifact_sha256', '')), 'Invalid source artifact checksum')
    return m


def write_env(values):
    destination = Path(os.environ['GITHUB_ENV'])
    with destination.open('a') as out:
        for key, value in values.items():
            require('\n' not in str(value) and '\r' not in str(value), 'Invalid environment value')
            out.write(f'{key}={value}\n')


def extract_apk(m, archive_path, directory):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if names == [APK_NAME]:
            source_name = APK_NAME
        else:
            require(BUILD_ARTIFACT_TV_NAME in names, 'TV APK not found in build artifact')
            require(all(name in {'Verlezza-Vision-Mobile.apk', BUILD_ARTIFACT_TV_NAME} for name in names), 'Unexpected file in build artifact')
            source_name = BUILD_ARTIFACT_TV_NAME
        member = archive.getinfo(source_name)
        require(0 < member.file_size <= 250 * 1024 * 1024, 'Unexpected APK size')
        data = archive.read(member)
    require(hashlib.sha256(data).hexdigest() == m['apk_sha256'], 'APK checksum mismatch')
    output = Path(directory)
    output.mkdir(parents=True, exist_ok=True)
    (output / APK_NAME).write_bytes(data)
    (output / 'SHA256SUMS.txt').write_text(f"{m['apk_sha256']}  {APK_NAME}\n")


def verify_android(m, badging, signature):
    certificates = set(re.findall(r'certificate SHA-256 digest:\s*([0-9a-f]{64})', signature))
    require(certificates == {CERTIFICATE}, 'APK signing certificate changed or was not recognized')
    package_line = next((line for line in badging.splitlines() if line.startswith('package: ')), '')
    fields = dict(re.findall(r"(\w+)='([^']*)'", package_line))
    require(fields.get('name') == PACKAGE, 'Wrong Android package')
    require(fields.get('versionCode') == str(m['version_code']), 'Wrong Android version code')
    require(fields.get('versionName') == m['version_name'], 'Wrong Android version name')
    require("application-label:'Verlezza Vision'" in badging.splitlines(), 'Wrong application name')
    require("sdkVersion:'21'" in badging.splitlines(), 'Minimum Android version changed')
    require(f"leanback-launchable-activity: name='{ACTIVITY}'" in badging, 'TV launcher entry point missing')


def release_action(m, latest):
    tag = latest.get('tag_name', '')
    match = re.fullmatch(r'verlezza-tv-([0-9]+)', tag)
    if match and int(match.group(1)) > m['version_code']:
        return 'superseded'
    if tag == f"verlezza-tv-{m['version_code']}":
        return 'already_latest'
    return 'publish'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'extract', 'verify', 'release-state'])
    parser.add_argument('manifest')
    parser.add_argument('files', nargs='*')
    args = parser.parse_args()
    m = read_manifest(args.manifest)
    if args.command == 'prepare':
        write_env({'VV_ARCHIVE_URL': m['archive_url'], 'VV_APK_SHA256': m['apk_sha256'],
                   'VV_VERSION_CODE': m['version_code'], 'VV_VERSION_NAME': m['version_name'],
                   'VV_RELEASE_TAG': f"verlezza-tv-{m['version_code']}"})
    elif args.command == 'extract':
        require(len(args.files) == 1, 'Expected archive path')
        extract_apk(m, args.files[0], '.')
    elif args.command == 'verify':
        require(len(args.files) == 2, 'Expected badging and signature reports')
        verify_android(m, Path(args.files[0]).read_text(), Path(args.files[1]).read_text())
    else:
        require(len(args.files) == 1, 'Expected latest release metadata')
        action = release_action(m, json.loads(Path(args.files[0]).read_text()))
        write_env({'VV_RELEASE_ACTION': action})
        print('Release action:', action)


if __name__ == '__main__':
    main()
