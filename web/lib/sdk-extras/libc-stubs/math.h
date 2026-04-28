#ifndef _MATH_H_STUB
#define _MATH_H_STUB

// Declaration-only shim. Bodies live in newlib's libm.a (linked from
// /pico-sdk/lib/newlib/libm.a in compiler.js). If you add a function
// here and it link-fails, it's not in the cortex-m33/softfp multilib
// archive we ship — pick a different name or ship a shim.
//
// Caveat (intentional, see pico_poe_user.h): including this header AFTER
// "pico_poe_user.h" in the same translation unit will leave `log` aliased
// to our printf-style `poe_log`, and calls to math `log` won't typecheck.
// Workarounds:
//   (a) #include <math.h> BEFORE "pico_poe_user.h", OR
//   (b) use logf() / log2() / log10() / log1p() (none of those are aliased), OR
//   (c) #undef log after including "pico_poe_user.h", at the cost of the
//       printf-style log() shorthand for the rest of the TU.

// IEEE 754 special values + classification macros. Provided by clang's
// builtins so they expand inline without needing newlib headers.
#define HUGE_VAL    (__builtin_huge_val())
#define HUGE_VALF   (__builtin_huge_valf())
#define HUGE_VALL   (__builtin_huge_vall())
#define INFINITY    (__builtin_inff())
#define NAN         (__builtin_nanf(""))

#define M_E         2.7182818284590452354
#define M_LOG2E     1.4426950408889634074
#define M_LOG10E    0.43429448190325182765
#define M_LN2       0.69314718055994530942
#define M_LN10      2.30258509299404568402
#define M_PI        3.14159265358979323846
#define M_PI_2      1.57079632679489661923
#define M_PI_4      0.78539816339744830962
#define M_1_PI      0.31830988618379067154
#define M_2_PI      0.63661977236758134308
#define M_2_SQRTPI  1.12837916709551257390
#define M_SQRT2     1.41421356237309504880
#define M_SQRT1_2   0.70710678118654752440

#define FP_NAN       0
#define FP_INFINITE  1
#define FP_ZERO      2
#define FP_SUBNORMAL 3
#define FP_NORMAL    4

#define fpclassify(x) __builtin_fpclassify( \
    FP_NAN, FP_INFINITE, FP_NORMAL, FP_SUBNORMAL, FP_ZERO, (x))
#define isfinite(x)   __builtin_isfinite(x)
#define isinf(x)      __builtin_isinf(x)
#define isnan(x)      __builtin_isnan(x)
#define isnormal(x)   __builtin_isnormal(x)
#define signbit(x)    __builtin_signbit(x)

// --- double-precision (newlib libm.a) -------------------------------------
double sin(double);   double cos(double);   double tan(double);
double asin(double);  double acos(double);  double atan(double);
double atan2(double, double);
double sinh(double);  double cosh(double);  double tanh(double);
double asinh(double); double acosh(double); double atanh(double);
double exp(double);   double exp2(double);  double expm1(double);
double log(double);   double log2(double);  double log10(double); double log1p(double);
double pow(double, double);
double sqrt(double);  double cbrt(double);  double hypot(double, double);
double ceil(double);  double floor(double); double trunc(double); double round(double);
double fabs(double);  double fmod(double, double); double remainder(double, double);
double fmin(double, double); double fmax(double, double);
double copysign(double, double); double nan(const char *);
double frexp(double, int *); double ldexp(double, int);
double modf(double, double *);
double erf(double);   double erfc(double);
double tgamma(double); double lgamma(double);

// --- single-precision ----------------------------------------------------
float sinf(float);    float cosf(float);    float tanf(float);
float asinf(float);   float acosf(float);   float atanf(float);
float atan2f(float, float);
float sinhf(float);   float coshf(float);   float tanhf(float);
float asinhf(float);  float acoshf(float);  float atanhf(float);
float expf(float);    float exp2f(float);   float expm1f(float);
float logf(float);    float log2f(float);   float log10f(float); float log1pf(float);
float powf(float, float);
float sqrtf(float);   float cbrtf(float);   float hypotf(float, float);
float ceilf(float);   float floorf(float);  float truncf(float); float roundf(float);
float fabsf(float);   float fmodf(float, float); float remainderf(float, float);
float fminf(float, float); float fmaxf(float, float);
float copysignf(float, float); float nanf(const char *);
float frexpf(float, int *); float ldexpf(float, int);
float modff(float, float *);
float erff(float);    float erfcf(float);
float tgammaf(float); float lgammaf(float);

#endif
