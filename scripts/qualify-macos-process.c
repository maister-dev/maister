#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

/* The fixture supplies the PID of its own disposable sibling process. */
int main(int argc, char **argv) {
    if (argc != 2) {
        return EXIT_FAILURE;
    }

    char *end;
    const long pid = strtol(argv[1], &end, 10);
    if (*end != '\0' || pid <= 0 || pid > INT_MAX) {
        return EXIT_FAILURE;
    }

    struct proc_bsdinfo info;
    const int size = proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size == sizeof(info)) {
        puts("ok");
        return EXIT_SUCCESS;
    }
    if (size == 0 && errno == EPERM) {
        puts("EPERM");
        return EXIT_SUCCESS;
    }

    perror("proc_pidinfo");
    return EXIT_FAILURE;
}
