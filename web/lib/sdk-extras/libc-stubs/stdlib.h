#ifndef _STDLIB_H_STUB
#define _STDLIB_H_STUB
#include <stddef.h>

// All bodies live in newlib's libc.a — we just need declarations so user
// code can call them without implicit-function-declaration warnings. If
// you add a function here and it links-fails, it's not in the multilib
// archive we ship under /pico-sdk/lib/newlib; pick a different one or
// ship a shim.

#define RAND_MAX 0x7fffffff
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

typedef struct { int quot, rem; }           div_t;
typedef struct { long quot, rem; }          ldiv_t;
typedef struct { long long quot, rem; }     lldiv_t;

void *malloc(size_t);
void  free(void *);
void *calloc(size_t, size_t);
void *realloc(void *, size_t);

void  abort(void) __attribute__((noreturn));
void  exit(int)   __attribute__((noreturn));

int   rand(void);
void  srand(unsigned);

int       atoi(const char *);
long      atol(const char *);
long long atoll(const char *);
double    atof(const char *);

long               strtol  (const char *, char **, int);
unsigned long      strtoul (const char *, char **, int);
long long          strtoll (const char *, char **, int);
unsigned long long strtoull(const char *, char **, int);
float              strtof  (const char *, char **);
double             strtod  (const char *, char **);

int       abs (int);
long      labs(long);
long long llabs(long long);
div_t     div (int, int);
ldiv_t    ldiv(long, long);
lldiv_t   lldiv(long long, long long);

void  qsort  (void *, size_t, size_t, int (*)(const void *, const void *));
void *bsearch(const void *, const void *, size_t, size_t,
              int (*)(const void *, const void *));

#endif
