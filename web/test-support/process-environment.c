#include <sys/sysctl.h>
#include <sys/types.h>
#include <libproc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

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
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) || argmax <= 0) return 70;
  char *buffer = malloc((size_t)argmax);
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (!buffer || bytes <= 0) return 70;
  size_t capacity = (size_t)bytes + 4096 * sizeof(pid_t);
  pid_t *pids = malloc(capacity);
  if (!pids) return 70;
  bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)capacity);
  if (bytes <= 0 || (size_t)bytes >= capacity) return 70;
  char entry[256];
  snprintf(entry, sizeof(entry), "MAISTER_TEST_WORKTREE_INVOCATION_ID=%s", argv[1]);
  char inspector_entry[256];
  snprintf(inspector_entry, sizeof(inspector_entry), "MAISTER_TEST_PROCESS_INSPECTOR=%s", argv[1]);
  for (size_t i = 0; i < (size_t)bytes / sizeof(pid_t); i++) {
    struct proc_bsdinfo info;
    /* The untagged inspector shares its caller's group but is not a group owner. */
    if (pids[i] <= 0 || pids[i] == getpid() || (selected && pids[i] != selected)) continue;
    int found = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (found != sizeof(info) || info.pbi_uid != getuid()) continue;
    int owned = owns_invocation(pids[i], entry, buffer, (size_t)argmax);
    if (owns_invocation(pids[i], inspector_entry, buffer, (size_t)argmax) == 1) continue;
    struct proc_bsdinfo after;
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) continue;
    if (after.pbi_start_tvsec != info.pbi_start_tvsec || after.pbi_start_tvusec != info.pbi_start_tvusec) continue;
    printf("%u\t%u\t%u\t%u\t%llu:%llu\t%d\t%u\n", info.pbi_pid, info.pbi_ppid, info.pbi_pgid, info.pbi_uid, info.pbi_start_tvsec, info.pbi_start_tvusec, owned, info.pbi_status);
  }
  free(buffer);
  free(pids);
  return ferror(stdout) ? 74 : 0;
}
