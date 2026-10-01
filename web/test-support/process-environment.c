#include <sys/sysctl.h>
#include <sys/types.h>
#include <libproc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Fixed fields only: diagnostics must never disclose argv or environment bytes. */
static void inspection_diagnostic(pid_t pid, const char *stage, long long result, long long expected, int error) {
  fprintf(stderr, "{\"event\":\"process-inspection-failed\",\"pid\":%d,\"stage\":\"%s\",\"result\":%lld,\"expected\":%lld,\"errno\":%d}\n", pid, stage, result, expected, error);
}

/* Read only the requested environment entry; argv can never establish ownership. */
static int owns_invocation(pid_t pid, const char *entry, char *buffer, size_t capacity) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t length = capacity;
  if (sysctl(mib, 3, buffer, &length, NULL, 0) != 0) return -errno;
  if (length < sizeof(int)) return -EINVAL;
  int argc;
  memcpy(&argc, buffer, sizeof(argc));
  char *cursor = buffer + sizeof(argc), *end = buffer + length;
  if (argc < 0) return -EINVAL;
  while (cursor < end && *cursor) cursor++;
  while (cursor < end && !*cursor) cursor++;
  for (int i = 0; i < argc; i++) {
    char *next = memchr(cursor, 0, (size_t)(end - cursor));
    if (!next) return -EINVAL;
    cursor = next + 1;
  }
  while (cursor < end) {
    char *next = memchr(cursor, 0, (size_t)(end - cursor));
    if (!next) return -EINVAL;
    if ((size_t)(next - cursor) == strlen(entry) && !memcmp(cursor, entry, strlen(entry))) return 1;
    cursor = next + 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if ((argc != 2 && argc != 3) || strlen(argv[1]) > 160) return 64;
  pid_t selected = 0;
  if (argc == 3) {
    char *end;
    long value = strtol(argv[2], &end, 10);
    if (*end || value <= 0 || value > 2147483647) return 64;
    selected = (pid_t)value;
  }
  int mib[] = {CTL_KERN, KERN_ARGMAX}, argmax = 0;
  size_t size = sizeof(argmax);
  errno = 0;
  int argmax_result = sysctl(mib, 2, &argmax, &size, NULL, 0);
  int argmax_error = errno;
  if (argmax_result || argmax <= 0) {
    inspection_diagnostic(selected, "kern_argmax", argmax_result, 0, argmax_error);
    return 70;
  }
  char *buffer = malloc((size_t)argmax);
  errno = 0;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  int list_error = errno;
  if (!buffer || bytes <= 0) {
    inspection_diagnostic(selected, buffer ? "proc_listpids_size" : "argument_buffer", bytes, 1, buffer ? list_error : ENOMEM);
    return 70;
  }
  size_t capacity = (size_t)bytes + 4096 * sizeof(pid_t);
  pid_t *pids = malloc(capacity);
  if (!pids) {
    inspection_diagnostic(selected, "pid_buffer", 0, capacity, ENOMEM);
    return 70;
  }
  errno = 0;
  bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)capacity);
  list_error = errno;
  if (bytes <= 0 || (size_t)bytes >= capacity) {
    inspection_diagnostic(selected, "proc_listpids", bytes, capacity, list_error);
    return 70;
  }
  char entry[256];
  snprintf(entry, sizeof(entry), "MAISTER_TEST_WORKTREE_INVOCATION_ID=%s", argv[1]);
  char inspector_entry[256];
  snprintf(inspector_entry, sizeof(inspector_entry), "MAISTER_TEST_PROCESS_INSPECTOR=%s", argv[1]);
  int selected_seen = 0;
  for (size_t i = 0; i < (size_t)bytes / sizeof(pid_t); i++) {
    struct proc_bsdinfo info;
    /* The untagged inspector shares its caller's group but is not a group owner. */
    if (pids[i] <= 0 || pids[i] == getpid() || (selected && pids[i] != selected)) continue;
    if (selected) selected_seen = 1;
    errno = 0;
    int found = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    int info_error = errno;
    if (found != sizeof(info)) {
      if (selected) inspection_diagnostic(selected, "proc_pidinfo_before", found, sizeof(info), info_error);
      continue;
    }
    if (info.pbi_uid != getuid()) {
      if (selected) inspection_diagnostic(selected, "uid_mismatch", info.pbi_uid, getuid(), 0);
      continue;
    }
    int owned = owns_invocation(pids[i], entry, buffer, (size_t)argmax);
    if (selected && owned < 0) inspection_diagnostic(selected, "kern_procargs", owned, 0, -owned);
    if (owns_invocation(pids[i], inspector_entry, buffer, (size_t)argmax) == 1) continue;
    struct proc_bsdinfo after;
    errno = 0;
    found = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof(after));
    info_error = errno;
    if (found != sizeof(after)) {
      if (selected) inspection_diagnostic(selected, "proc_pidinfo_after", found, sizeof(after), info_error);
      continue;
    }
    if (after.pbi_start_tvsec != info.pbi_start_tvsec || after.pbi_start_tvusec != info.pbi_start_tvusec) {
      if (selected) inspection_diagnostic(selected, "start_identity_changed", 0, 0, 0);
      continue;
    }
    printf("%u\t%u\t%u\t%u\t%llu:%llu\t%d\t%u\n", info.pbi_pid, info.pbi_ppid, info.pbi_pgid, info.pbi_uid, info.pbi_start_tvsec, info.pbi_start_tvusec, owned, info.pbi_status);
  }
  if (selected && !selected_seen) inspection_diagnostic(selected, "selected_pid_missing", 0, 1, 0);
  free(buffer);
  free(pids);
  return ferror(stdout) ? 74 : 0;
}
